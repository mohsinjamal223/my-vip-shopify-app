import { useEffect, useState } from "react";
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
  TextField,
  Banner,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  VIP_TIER_TYPE as METAOBJECT_TYPE,
  TIER_FIELD_DEFINITIONS as FIELD_DEFINITIONS,
  type TierFieldKey as FieldKey,
  ensureTierDefinition,
} from "../vip.server";

// ---------------------------------------------------------------------------
// VIP Tier system (Gold / Silver / Bronze) backed by Shopify metaobjects.
//
// Each tier is a `vip_tier` metaobject. The metaobject definition is created
// automatically on first visit (idempotent) so the merchant never has to set
// it up by hand. Tiers are stored in Shopify — not Prisma — so a theme or app
// extension can read them on the storefront via the metaobject API.
// ---------------------------------------------------------------------------

// The shape we send to/receive from the client for a single tier.
type Tier = {
  id: string | null; // null = unsaved draft
  name: string;
  tier_level: string;
  badge_color: string;
  badge_icon: string;
  discount_percentage: string;
  min_spend: string;
  benefits: string;
};

// Sensible defaults used by the "Create default tiers" button.
const DEFAULT_TIERS: Omit<Tier, "id">[] = [
  {
    name: "Gold",
    tier_level: "3",
    badge_color: "#D4AF37",
    badge_icon: "🥇",
    discount_percentage: "20",
    min_spend: "1000",
    benefits: "Free express shipping\nEarly access to new drops\nDedicated VIP support",
  },
  {
    name: "Silver",
    tier_level: "2",
    badge_color: "#AEB4B8",
    badge_icon: "🥈",
    discount_percentage: "10",
    min_spend: "500",
    benefits: "Free shipping\nMember-only deals",
  },
  {
    name: "Bronze",
    tier_level: "1",
    badge_color: "#CD7F32",
    badge_icon: "🥉",
    discount_percentage: "5",
    min_spend: "100",
    benefits: "Member-only deals",
  },
];

const emptyTier = (): Tier => ({
  id: null,
  name: "",
  tier_level: "",
  badge_color: "#5C6AC4",
  badge_icon: "⭐",
  discount_percentage: "",
  min_spend: "",
  benefits: "",
});

// --- GraphQL documents ------------------------------------------------------

const TIERS_QUERY = `#graphql
  query Tiers($type: String!) {
    metaobjects(type: $type, first: 50) {
      nodes {
        id
        fields {
          key
          value
        }
      }
    }
  }
`;

const TIER_CREATE_MUTATION = `#graphql
  mutation CreateTier($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const TIER_UPDATE_MUTATION = `#graphql
  mutation UpdateTier($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const TIER_DELETE_MUTATION = `#graphql
  mutation DeleteTier($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }
`;

// --- Helpers ----------------------------------------------------------------

// Turn a tier form object into the metaobject `fields` array, dropping empty
// values so optional fields don't trip validation (e.g. an empty color).
function tierToFields(form: Record<FieldKey, string>) {
  return FIELD_DEFINITIONS.map((f) => ({ key: f.key, value: form[f.key]?.trim() ?? "" }))
    .filter((f) => f.value.length > 0);
}

// --- Loader -----------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  await ensureTierDefinition(admin);

  const response = await admin.graphql(TIERS_QUERY, {
    variables: { type: METAOBJECT_TYPE },
  });
  const body = await response.json();
  const nodes = body.data?.metaobjects?.nodes ?? [];

  const tiers: Tier[] = nodes.map((node: any) => {
    const map: Record<string, string> = {};
    for (const field of node.fields) {
      map[field.key] = field.value ?? "";
    }
    return {
      id: node.id,
      name: map.name ?? "",
      tier_level: map.tier_level ?? "",
      badge_color: map.badge_color ?? "#5C6AC4",
      badge_icon: map.badge_icon ?? "⭐",
      discount_percentage: map.discount_percentage ?? "",
      min_spend: map.min_spend ?? "",
      benefits: map.benefits ?? "",
    };
  });

  // Highest tier first (Gold → Silver → Bronze).
  tiers.sort((a, b) => Number(b.tier_level || 0) - Number(a.tier_level || 0));

  return json({ tiers });
};

// --- Action -----------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("_action");

  await ensureTierDefinition(admin);

  if (intent === "DELETE") {
    const id = formData.get("id") as string;
    const response = await admin.graphql(TIER_DELETE_MUTATION, {
      variables: { id },
    });
    const body = await response.json();
    const userErrors = body.data?.metaobjectDelete?.userErrors ?? [];
    return json({
      ok: userErrors.length === 0,
      errors: userErrors.map((e: any) => e.message),
    });
  }

  if (intent === "SEED") {
    const results = await Promise.all(
      DEFAULT_TIERS.map(async (tier) => {
        const response = await admin.graphql(TIER_CREATE_MUTATION, {
          variables: {
            metaobject: { type: METAOBJECT_TYPE, fields: tierToFields(tier) },
          },
        });
        const body = await response.json();
        return body.data?.metaobjectCreate?.userErrors ?? [];
      }),
    );
    const errors = results.flat();
    return json({
      ok: errors.length === 0,
      errors: errors.map((e: any) => e.message),
    });
  }

  // SAVE — create when there's no id, otherwise update.
  const id = formData.get("id") as string | null;
  const form = Object.fromEntries(
    FIELD_DEFINITIONS.map((f) => [f.key, (formData.get(f.key) as string) ?? ""]),
  ) as Record<FieldKey, string>;

  if (!form.name?.trim()) {
    return json({ ok: false, errors: ["Tier name is required."] });
  }

  const fields = tierToFields(form);

  if (id) {
    const response = await admin.graphql(TIER_UPDATE_MUTATION, {
      variables: { id, metaobject: { fields } },
    });
    const body = await response.json();
    const userErrors = body.data?.metaobjectUpdate?.userErrors ?? [];
    return json({
      ok: userErrors.length === 0,
      errors: userErrors.map((e: any) => e.message),
    });
  }

  const response = await admin.graphql(TIER_CREATE_MUTATION, {
    variables: { metaobject: { type: METAOBJECT_TYPE, fields } },
  });
  const body = await response.json();
  const userErrors = body.data?.metaobjectCreate?.userErrors ?? [];
  return json({
    ok: userErrors.length === 0,
    errors: userErrors.map((e: any) => e.message),
  });
};

// --- UI ---------------------------------------------------------------------

// Pick black or white text depending on how light the badge color is, so the
// label stays readable on Gold, Silver and Bronze alike.
function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  // Relative luminance (perceptual).
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1a1a1a" : "#ffffff";
}

function TierBadge({ tier }: { tier: Tier }) {
  const color = tier.badge_color || "#5C6AC4";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 12px",
        borderRadius: "999px",
        background: color,
        color: contrastText(color),
        fontWeight: 600,
        fontSize: "14px",
        lineHeight: "20px",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.08)",
      }}
    >
      <span aria-hidden>{tier.badge_icon || "⭐"}</span>
      {tier.name || "Untitled tier"}
    </span>
  );
}

function TierCard({ tier: initial }: { tier: Tier }) {
  const fetcher = useFetcher<typeof action>();
  const [tier, setTier] = useState<Tier>(initial);

  // Re-sync when the loader returns fresh data (e.g. after a sibling save).
  useEffect(() => setTier(initial), [initial]);

  const set = (key: keyof Tier) => (value: string) =>
    setTier((t) => ({ ...t, [key]: value }));

  const busy = fetcher.state !== "idle";

  const save = () => {
    fetcher.submit(
      {
        _action: "SAVE",
        ...(tier.id ? { id: tier.id } : {}),
        name: tier.name,
        tier_level: tier.tier_level,
        badge_color: tier.badge_color,
        badge_icon: tier.badge_icon,
        discount_percentage: tier.discount_percentage,
        min_spend: tier.min_spend,
        benefits: tier.benefits,
      },
      { method: "POST" },
    );
  };

  const remove = () => {
    if (!tier.id) return;
    fetcher.submit({ _action: "DELETE", id: tier.id }, { method: "POST" });
  };

  const saveError =
    fetcher.data && !fetcher.data.ok ? fetcher.data.errors?.join(", ") : null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <TierBadge tier={tier} />
          <Button
            variant="tertiary"
            tone="critical"
            disabled={busy || !tier.id}
            onClick={remove}
          >
            Delete
          </Button>
        </InlineStack>

        {saveError && (
          <Banner tone="critical">{saveError}</Banner>
        )}

        <InlineStack gap="300" wrap>
          <Box minWidth="180px">
            <TextField
              label="Tier name"
              value={tier.name}
              onChange={set("name")}
              autoComplete="off"
              placeholder="Gold"
            />
          </Box>
          <Box minWidth="120px">
            <TextField
              label="Tier level"
              type="number"
              value={tier.tier_level}
              onChange={set("tier_level")}
              autoComplete="off"
              helpText="Higher = better"
            />
          </Box>
          <Box minWidth="140px">
            <TextField
              label="Badge color"
              value={tier.badge_color}
              onChange={set("badge_color")}
              autoComplete="off"
              placeholder="#D4AF37"
              prefix="#"
            />
          </Box>
          <Box minWidth="100px">
            <TextField
              label="Badge icon"
              value={tier.badge_icon}
              onChange={set("badge_icon")}
              autoComplete="off"
              placeholder="🥇"
            />
          </Box>
        </InlineStack>

        <InlineStack gap="300" wrap>
          <Box minWidth="160px">
            <TextField
              label="Discount %"
              type="number"
              value={tier.discount_percentage}
              onChange={set("discount_percentage")}
              autoComplete="off"
              suffix="%"
            />
          </Box>
          <Box minWidth="160px">
            <TextField
              label="Minimum spend"
              type="number"
              value={tier.min_spend}
              onChange={set("min_spend")}
              autoComplete="off"
              prefix="$"
            />
          </Box>
        </InlineStack>

        <TextField
          label="Benefits"
          value={tier.benefits}
          onChange={set("benefits")}
          autoComplete="off"
          multiline={3}
          helpText="One benefit per line."
        />

        <InlineStack align="end">
          <Button variant="primary" loading={busy} onClick={save}>
            {tier.id ? "Save tier" : "Create tier"}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function VipTiers() {
  const { tiers } = useLoaderData<typeof loader>();
  const seedFetcher = useFetcher<typeof action>();
  // Locally-added draft tiers that haven't been saved to Shopify yet.
  const [drafts, setDrafts] = useState<Tier[]>([]);

  const seeding = seedFetcher.state !== "idle";

  const addDraft = () => setDrafts((d) => [...d, emptyTier()]);

  const seed = () =>
    seedFetcher.submit({ _action: "SEED" }, { method: "POST" });

  const hasTiers = tiers.length > 0;

  return (
    <Page
      title="VIP Tiers"
      subtitle="Gold, Silver & Bronze membership tiers with badges — stored as Shopify metaobjects."
      primaryAction={{ content: "Add tier", onAction: addDraft }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {!hasTiers && drafts.length === 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    No VIP tiers yet
                  </Text>
                  <Text as="p" tone="subdued">
                    Get started with the classic Gold, Silver and Bronze tiers —
                    each with its own badge, discount and benefits. You can edit
                    everything afterwards.
                  </Text>
                  <InlineStack gap="300">
                    <Button
                      variant="primary"
                      loading={seeding}
                      onClick={seed}
                    >
                      Create default tiers
                    </Button>
                    <Button onClick={addDraft}>Add a tier manually</Button>
                  </InlineStack>
                  {seedFetcher.data && !seedFetcher.data.ok && (
                    <Banner tone="critical">
                      {seedFetcher.data.errors?.join(", ")}
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            )}

            {tiers.map((tier) => (
              <TierCard key={tier.id} tier={tier} />
            ))}

            {drafts.map((draft, i) => (
              <TierCard key={`draft-${i}`} tier={draft} />
            ))}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
