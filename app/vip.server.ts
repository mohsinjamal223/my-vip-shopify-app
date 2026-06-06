// Shared server helpers for the VIP Tier system.
//
// Tiers are stored as `vip_tier` metaobjects (storefront-readable). A customer
// is linked to a tier through a `custom.vip_tier` customer metafield of type
// metaobject_reference. Both the tier definition and the customer metafield
// definition are created on demand (idempotent) so the merchant never has to
// set anything up by hand.

// Minimal shape of the authenticated admin GraphQL client.
type Admin = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export const VIP_TIER_TYPE = "vip_tier";

export const CUSTOMER_METAFIELD = {
  namespace: "custom",
  key: "vip_tier",
} as const;

// Field definitions for the tier metaobject. Single source of truth shared by
// the definition (create) and the editor form (read/write).
export const TIER_FIELD_DEFINITIONS = [
  { name: "Name", key: "name", type: "single_line_text_field", required: true },
  { name: "Tier level", key: "tier_level", type: "number_integer", required: false },
  { name: "Badge color", key: "badge_color", type: "color", required: false },
  { name: "Badge icon", key: "badge_icon", type: "single_line_text_field", required: false },
  { name: "Discount percentage", key: "discount_percentage", type: "number_integer", required: false },
  { name: "Minimum spend", key: "min_spend", type: "number_decimal", required: false },
  { name: "Benefits", key: "benefits", type: "multi_line_text_field", required: false },
] as const;

export type TierFieldKey = (typeof TIER_FIELD_DEFINITIONS)[number]["key"];

const DEFINITION_BY_TYPE_QUERY = `#graphql
  query DefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
    }
  }
`;

const DEFINITION_CREATE_MUTATION = `#graphql
  mutation CreateDefinition($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition {
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

const CUSTOMER_METAFIELD_DEFINITION_CREATE = `#graphql
  mutation CreateCustomerMetafieldDef($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
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

// Ignore "already exists" style errors so the ensure* helpers are safe to call
// on every request.
function ignorableExists(errors: any[]): any[] {
  return errors.filter(
    (e) => e.code !== "TAKEN" && !/already|taken/i.test(e.message ?? ""),
  );
}

// Ensure the `vip_tier` metaobject definition exists; returns its id.
export async function ensureTierDefinition(admin: Admin): Promise<string> {
  const lookup = await admin.graphql(DEFINITION_BY_TYPE_QUERY, {
    variables: { type: VIP_TIER_TYPE },
  });
  const lookupBody = await lookup.json();
  const existing = lookupBody.data?.metaobjectDefinitionByType?.id;
  if (existing) return existing;

  const response = await admin.graphql(DEFINITION_CREATE_MUTATION, {
    variables: {
      definition: {
        name: "VIP Tier",
        type: VIP_TIER_TYPE,
        access: { storefront: "PUBLIC_READ" },
        displayNameKey: "name",
        fieldDefinitions: TIER_FIELD_DEFINITIONS.map((f) => ({
          name: f.name,
          key: f.key,
          type: f.type,
          required: f.required,
        })),
      },
    },
  });
  const body = await response.json();
  const errors = ignorableExists(body.data?.metaobjectDefinitionCreate?.userErrors ?? []);
  if (errors.length > 0) {
    throw new Error(errors.map((e: any) => e.message).join(", "));
  }

  const createdId = body.data?.metaobjectDefinitionCreate?.metaobjectDefinition?.id;
  if (createdId) return createdId;

  // Lost a create race — look it up again.
  const retry = await admin.graphql(DEFINITION_BY_TYPE_QUERY, {
    variables: { type: VIP_TIER_TYPE },
  });
  const retryBody = await retry.json();
  return retryBody.data?.metaobjectDefinitionByType?.id;
}

// Ensure the customer `custom.vip_tier` metafield definition exists, linked to
// the tier metaobject definition so the admin/storefront know what it points to.
export async function ensureCustomerTierMetafield(admin: Admin, tierDefinitionId: string) {
  const response = await admin.graphql(CUSTOMER_METAFIELD_DEFINITION_CREATE, {
    variables: {
      definition: {
        name: "VIP Tier",
        namespace: CUSTOMER_METAFIELD.namespace,
        key: CUSTOMER_METAFIELD.key,
        ownerType: "CUSTOMER",
        type: "metaobject_reference",
        validations: [
          { name: "metaobject_definition_id", value: tierDefinitionId },
        ],
      },
    },
  });
  const body = await response.json();
  const errors = ignorableExists(body.data?.metafieldDefinitionCreate?.userErrors ?? []);
  if (errors.length > 0) {
    throw new Error(errors.map((e: any) => e.message).join(", "));
  }
}

export type TierOption = {
  id: string;
  name: string;
  badge_icon: string;
  badge_color: string;
};

// Fetch tiers as lightweight options (for dropdowns / badges), sorted best-first.
export async function getTierOptions(admin: Admin): Promise<TierOption[]> {
  const response = await admin.graphql(TIERS_QUERY, {
    variables: { type: VIP_TIER_TYPE },
  });
  const body = await response.json();
  const nodes = body.data?.metaobjects?.nodes ?? [];

  const tiers: (TierOption & { level: number })[] = nodes.map((node: any) => {
    const map: Record<string, string> = {};
    for (const field of node.fields) map[field.key] = field.value ?? "";
    return {
      id: node.id,
      name: map.name ?? "",
      badge_icon: map.badge_icon ?? "⭐",
      badge_color: map.badge_color ?? "#5C6AC4",
      level: Number(map.tier_level || 0),
    };
  });

  tiers.sort((a, b) => b.level - a.level);
  return tiers.map(({ level, ...rest }) => rest);
}
