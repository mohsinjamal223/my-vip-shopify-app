import { useState } from "react";
import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Select,
  Banner,
  Link as PolarisLink,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  CUSTOMER_METAFIELD,
  ensureCustomerTierMetafield,
  ensureTierDefinition,
  getTierOptions,
  type TierOption,
} from "../vip.server";

// ---------------------------------------------------------------------------
// Manual VIP tier assignment.
//
// Each customer carries a `custom.vip_tier` metafield (metaobject_reference)
// pointing at one of the tier metaobjects. The merchant picks a customer and a
// tier here; a theme app block then reads that metafield to show the badge on
// the storefront.
// ---------------------------------------------------------------------------

const CUSTOMERS_QUERY = `#graphql
  query Customers($namespace: String!, $key: String!) {
    customers(first: 100, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        displayName
        email
        metafield(namespace: $namespace, key: $key) {
          reference {
            ... on Metaobject {
              id
              tname: field(key: "name") { value }
              ticon: field(key: "badge_icon") { value }
              tcolor: field(key: "badge_color") { value }
            }
          }
        }
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation SetTier($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const METAFIELDS_DELETE_MUTATION = `#graphql
  mutation UnsetTier($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type Assignment = {
  id: string;
  name: string;
  badge_icon: string;
  badge_color: string;
} | null;

type Customer = {
  id: string;
  displayName: string;
  email: string | null;
  tier: Assignment;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const tierDefId = await ensureTierDefinition(admin);

  // Registering a *definition* for the customer metafield is optional polish
  // (it surfaces the field in the native customer admin). Shopify restricts
  // creating definitions in the `custom` namespace on the customer resource,
  // so treat any failure as non-fatal — assigning a tier only needs
  // metafieldsSet, which works without a definition.
  await ensureCustomerTierMetafield(admin, tierDefId).catch(() => {});

  const tiers = await getTierOptions(admin);

  // Reading the Customer object requires "Protected customer data access",
  // which is granted in the Partner Dashboard — not via scopes. If it isn't
  // enabled the query throws, so surface a friendly message instead of a crash.
  let customers: Customer[] = [];
  let customerAccessError: string | null = null;
  try {
    const response = await admin.graphql(CUSTOMERS_QUERY, {
      variables: { namespace: CUSTOMER_METAFIELD.namespace, key: CUSTOMER_METAFIELD.key },
    });
    const body = await response.json();
    const nodes = body.data?.customers?.nodes ?? [];

    customers = nodes.map((node: any) => {
      const ref = node.metafield?.reference;
      return {
        id: node.id,
        displayName: node.displayName || node.email || "Customer",
        email: node.email ?? null,
        tier: ref
          ? {
              id: ref.id,
              name: ref.tname?.value ?? "",
              badge_icon: ref.ticon?.value ?? "⭐",
              badge_color: ref.tcolor?.value ?? "#5C6AC4",
            }
          : null,
      };
    });
  } catch (e: any) {
    customerAccessError =
      e?.message ?? "Could not load customers. Customer data access may not be enabled.";
  }

  return json({ tiers, customers, customerAccessError });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("_action");
  const customerId = formData.get("customerId") as string;

  if (!customerId) {
    return json({ ok: false, errors: ["Please choose a customer."] });
  }

  if (intent === "UNASSIGN") {
    const response = await admin.graphql(METAFIELDS_DELETE_MUTATION, {
      variables: {
        metafields: [
          {
            ownerId: customerId,
            namespace: CUSTOMER_METAFIELD.namespace,
            key: CUSTOMER_METAFIELD.key,
          },
        ],
      },
    });
    const body = await response.json();
    const errors = body.data?.metafieldsDelete?.userErrors ?? [];
    return json({ ok: errors.length === 0, errors: errors.map((e: any) => e.message) });
  }

  // ASSIGN
  const tierId = formData.get("tierId") as string;
  if (!tierId) {
    return json({ ok: false, errors: ["Please choose a tier."] });
  }

  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: customerId,
          namespace: CUSTOMER_METAFIELD.namespace,
          key: CUSTOMER_METAFIELD.key,
          type: "metaobject_reference",
          value: tierId,
        },
      ],
    },
  });
  const body = await response.json();
  const errors = body.data?.metafieldsSet?.userErrors ?? [];
  return json({ ok: errors.length === 0, errors: errors.map((e: any) => e.message) });
};

function Badge({ tier }: { tier: NonNullable<Assignment> }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "2px 10px",
        borderRadius: "999px",
        background: tier.badge_color || "#5C6AC4",
        color: "#1a1a1a",
        fontWeight: 600,
        fontSize: "13px",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.12)",
      }}
    >
      <span aria-hidden>{tier.badge_icon || "⭐"}</span>
      {tier.name || "Tier"}
    </span>
  );
}

export default function VipCustomers() {
  const { tiers, customers, customerAccessError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [customerId, setCustomerId] = useState("");
  const [tierId, setTierId] = useState(tiers[0]?.id ?? "");

  const busy = fetcher.state !== "idle";
  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.errors?.join(", ") : null;

  const assign = () => {
    fetcher.submit({ _action: "ASSIGN", customerId, tierId }, { method: "POST" });
  };

  const unassign = (id: string) => {
    fetcher.submit({ _action: "UNASSIGN", customerId: id }, { method: "POST" });
  };

  const customerOptions = [
    { label: "Select a customer…", value: "" },
    ...customers.map((c) => ({
      label: c.email ? `${c.displayName} · ${c.email}` : c.displayName,
      value: c.id,
    })),
  ];

  const tierOptions = tiers.map((t: TierOption) => ({
    label: `${t.badge_icon} ${t.name}`,
    value: t.id,
  }));

  const assigned = customers.filter((c) => c.tier);
  const noTiers = tiers.length === 0;

  return (
    <Page
      title="Assign VIP Tiers"
      subtitle="Give individual customers a tier. The badge then shows on the storefront for that customer."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {customerAccessError && (
              <Banner tone="critical" title="Customer data access not enabled">
                <BlockStack gap="200">
                  <p>
                    This app can't read customers yet. Reading the Customer object
                    requires <strong>Protected customer data access</strong>, which
                    is enabled in the Partner Dashboard (separate from API scopes).
                  </p>
                  <p>
                    Go to <strong>Partner Dashboard → your app → API access →
                    Protected customer data access</strong>, request access, and
                    also enable the <strong>name</strong> and <strong>email</strong>{" "}
                    protected fields. Then restart <code>shopify app dev</code>.
                  </p>
                  <p>
                    <PolarisLink url="https://shopify.dev/docs/apps/launch/protected-customer-data" target="_blank">
                      Shopify docs: Protected customer data
                    </PolarisLink>
                  </p>
                </BlockStack>
              </Banner>
            )}
            {noTiers && (
              <Banner tone="warning" title="No tiers to assign yet">
                <p>
                  Create your Gold / Silver / Bronze tiers first on the{" "}
                  <PolarisLink url="/app/vip-tiers">VIP Tiers</PolarisLink> page.
                </p>
              </Banner>
            )}

            {error && <Banner tone="critical">{error}</Banner>}
            {fetcher.data?.ok && (
              <Banner tone="success">Customer tier updated.</Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Assign a tier
                </Text>
                <InlineStack gap="300" align="start" blockAlign="end" wrap>
                  <div style={{ minWidth: 280 }}>
                    <Select
                      label="Customer"
                      options={customerOptions}
                      value={customerId}
                      onChange={setCustomerId}
                    />
                  </div>
                  <div style={{ minWidth: 200 }}>
                    <Select
                      label="Tier"
                      options={tierOptions}
                      value={tierId}
                      onChange={setTierId}
                      disabled={noTiers}
                    />
                  </div>
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={!customerId || !tierId || noTiers}
                    onClick={assign}
                  >
                    Assign tier
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Showing the 100 most recently updated customers.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Current assignments
                </Text>
                {assigned.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No customers have a tier yet.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {assigned.map((c) => (
                      <InlineStack
                        key={c.id}
                        align="space-between"
                        blockAlign="center"
                        gap="300"
                      >
                        <InlineStack gap="300" blockAlign="center">
                          <Badge tier={c.tier!} />
                          <Text as="span">
                            {c.displayName}
                            {c.email ? ` · ${c.email}` : ""}
                          </Text>
                        </InlineStack>
                        <Button
                          variant="tertiary"
                          tone="critical"
                          disabled={busy}
                          onClick={() => unassign(c.id)}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
