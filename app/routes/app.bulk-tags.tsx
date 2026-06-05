import { useEffect, useState } from "react";
import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Tag,
  Banner,
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Shopify's tagsAdd mutation adds tags to a single resource at a time.
// To "bulk" tag multiple products in one click we run the mutation once
// per selected product inside a single action call.
const TAGS_ADD_MUTATION = `#graphql
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Restore the previously saved selection so it survives a page reload.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const saved = await db.taggedProduct.findMany({
    orderBy: { updatedAt: "desc" },
  });
  return json({ saved });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("_action");

  // Clearing the saved selection from the database.
  if (intent === "CLEAR") {
    await db.taggedProduct.deleteMany();
    return json({ ok: true, cleared: true });
  }

  // Persist the current selection (products + tags) so it survives a reload
  // even before the user has applied the tags to Shopify.
  if (intent === "SAVE") {
    const products = JSON.parse(
      (formData.get("products") as string) || "[]",
    ) as { id: string; title: string }[];
    const tags = JSON.parse(
      (formData.get("tags") as string) || "[]",
    ) as string[];

    await db.$transaction([
      db.taggedProduct.deleteMany(),
      db.taggedProduct.createMany({
        data: products.map((p) => ({
          productId: p.id,
          title: p.title,
          tags: tags.join(","),
        })),
      }),
    ]);
    return json({ ok: true, saved: true });
  }

  const products = JSON.parse(
    (formData.get("products") as string) || "[]",
  ) as { id: string; title: string }[];
  const tags = JSON.parse((formData.get("tags") as string) || "[]") as string[];

  if (products.length === 0) {
    return json({ ok: false, error: "Please select at least one product." });
  }
  if (tags.length === 0) {
    return json({ ok: false, error: "Please add at least one tag." });
  }

  // Run the tagsAdd mutation for every selected product in parallel.
  const results = await Promise.all(
    products.map(async ({ id }) => {
      const response = await admin.graphql(TAGS_ADD_MUTATION, {
        variables: { id, tags },
      });
      const body = await response.json();
      const userErrors = body.data?.tagsAdd?.userErrors ?? [];
      return { id, userErrors };
    }),
  );

  const failed = results.filter((r) => r.userErrors.length > 0);
  const failedIds = new Set(failed.map((r) => r.id));

  // Persist the products that were tagged successfully so the selection
  // (and the tags applied) reappears after a page reload.
  await Promise.all(
    products
      .filter((p) => !failedIds.has(p.id))
      .map((p) =>
        db.taggedProduct.upsert({
          where: { productId: p.id },
          update: { title: p.title, tags: tags.join(",") },
          create: { productId: p.id, title: p.title, tags: tags.join(",") },
        }),
      ),
  );

  return json({
    ok: failed.length === 0,
    updated: results.length - failed.length,
    total: results.length,
    tags,
    errors: failed.flatMap((r) => r.userErrors.map((e: any) => e.message)),
  });
};

const SAVE_BAR_ID = "bulk-tags-save-bar";

type Product = { id: string; title: string };

// Build the initial products/tags from whatever was saved in the database.
const savedToProducts = (saved: { productId: string; title: string }[]): Product[] =>
  saved.map((s) => ({ id: s.productId, title: s.title }));

const savedToTags = (saved: { tags: string }[]): string[] =>
  Array.from(
    new Set(saved.flatMap((s) => s.tags.split(",")).filter((t) => t.length > 0)),
  );

export default function BulkTags() {
  const { saved } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  // Separate fetcher for persisting the selection so it never interferes with
  // the Apply/Clear flow or its success/error banners.
  const saveFetcher = useFetcher<typeof action>();

  // The currently saved baseline — what a reload would restore and what
  // "Discard" reverts back to.
  const [baseline, setBaseline] = useState<{ products: Product[]; tags: string[] }>(
    { products: savedToProducts(saved), tags: savedToTags(saved) },
  );

  // The working copy the user is editing.
  const [products, setProducts] = useState<Product[]>(baseline.products);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>(baseline.tags);

  const isSubmitting = fetcher.state !== "idle";
  const isSaving = saveFetcher.state !== "idle";
  const result = fetcher.data;

  // There are unsaved changes whenever the working copy differs from the
  // saved baseline.
  const dirty =
    JSON.stringify(products) !== JSON.stringify(baseline.products) ||
    JSON.stringify(tags) !== JSON.stringify(baseline.tags);

  // Show Shopify's contextual Save bar while there are unsaved changes.
  useEffect(() => {
    if (dirty) {
      shopify.saveBar.show(SAVE_BAR_ID);
    } else {
      shopify.saveBar.hide(SAVE_BAR_ID);
    }
  }, [dirty, shopify]);

  // Once a save persists successfully, the working copy becomes the new
  // baseline (which hides the Save bar).
  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.ok && "saved" in saveFetcher.data) {
      setBaseline({ products, tags });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.state, saveFetcher.data]);

  const selectProducts = async () => {
    const selected = await window.shopify.resourcePicker({
      type: "product",
      multiple: true,
      // Pre-check the products that are already selected.
      selectionIds: products.map((p) => ({ id: p.id })),
    });

    if (selected) {
      setProducts(selected.map((p: any) => ({ id: p.id, title: p.title })));
    }
  };

  const addTag = () => {
    const value = tagInput.trim();
    if (value && !tags.includes(value)) {
      setTags([...tags, value]);
    }
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const removeProduct = (id: string) => {
    setProducts(products.filter((p) => p.id !== id));
  };

  // Save bar primary action: persist the current selection to the database.
  const handleSave = () => {
    saveFetcher.submit(
      {
        _action: "SAVE",
        products: JSON.stringify(products),
        tags: JSON.stringify(tags),
      },
      { method: "POST" },
    );
  };

  // Save bar secondary action: throw away unsaved edits.
  const handleDiscard = () => {
    setProducts(baseline.products);
    setTags(baseline.tags);
    setTagInput("");
  };

  const applyTags = () => {
    fetcher.submit(
      {
        products: JSON.stringify(products),
        tags: JSON.stringify(tags),
      },
      { method: "POST" },
    );
  };

  const clearSaved = () => {
    setProducts([]);
    setTags([]);
    setBaseline({ products: [], tags: [] });
    fetcher.submit({ _action: "CLEAR" }, { method: "POST" });
  };

  const canApply = products.length > 0 && tags.length > 0 && !isSubmitting && !dirty;

  return (
    <Page title="Bulk Product Tagging">
      <SaveBar id={SAVE_BAR_ID}>
        <button variant="primary" loading={isSaving ? "" : undefined} onClick={handleSave}>
          Save
        </button>
        <button onClick={handleDiscard}>Discard</button>
      </SaveBar>
      <Layout>
        <Layout.Section>
          {result?.ok && "updated" in result && (
            <Banner tone="success" title="Tags applied">
              <p>
                Added {result.tags.join(", ")} to {result.updated} of{" "}
                {result.total} products.
              </p>
            </Banner>
          )}
          {result && !result.ok && (
            <Banner tone="critical" title="Could not apply tags">
              {"error" in result && result.error ? (
                <p>{result.error}</p>
              ) : "errors" in result ? (
                <List>
                  {result.errors?.map((msg, i) => (
                    <List.Item key={i}>{msg}</List.Item>
                  ))}
                </List>
              ) : null}
            </Banner>
          )}

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                1. Select products
              </Text>
              <Button onClick={selectProducts}>
                {products.length > 0
                  ? `${products.length} product(s) selected`
                  : "Select products"}
              </Button>
              {products.length > 0 && (
                <List>
                  {products.map((p) => (
                    <List.Item key={p.id}>
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                        gap="200"
                      >
                        <Text as="span">{p.title}</Text>
                        <Button
                          variant="tertiary"
                          tone="critical"
                          onClick={() => removeProduct(p.id)}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    </List.Item>
                  ))}
                </List>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                2. Add tags
              </Text>
              <InlineStack gap="200" blockAlign="end">
                <div style={{ flexGrow: 1 }}>
                  <TextField
                    label="Tag"
                    labelHidden
                    value={tagInput}
                    onChange={setTagInput}
                    placeholder="e.g. summer-sale"
                    autoComplete="off"
                    onBlur={addTag}
                  />
                </div>
                <Button onClick={addTag}>Add tag</Button>
              </InlineStack>
              {tags.length > 0 && (
                <InlineStack gap="200">
                  {tags.map((tag) => (
                    <Tag key={tag} onRemove={() => removeTag(tag)}>
                      {tag}
                    </Tag>
                  ))}
                </InlineStack>
              )}
            </BlockStack>
          </Card>

          <Card>
            <InlineStack align="space-between">
              <Button
                tone="critical"
                variant="tertiary"
                disabled={isSubmitting || (products.length === 0 && tags.length === 0)}
                onClick={clearSaved}
              >
                Clear saved
              </Button>
              <Button
                variant="primary"
                disabled={!canApply}
                loading={isSubmitting}
                onClick={applyTags}
              >
                Apply tags to all selected
              </Button>
            </InlineStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
