import { json, type ActionFunctionArgs } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { Page, Layout, Card, Button, BlockStack, Text, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// ==========================================
// 1. THE UPDATED BACKEND ACTION 
// ==========================================
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const productId = formData.get("productId") as string;
  const newPrice = formData.get("newPrice") as string;

  try {
    // A: First, we still grab the variant ID for that product
    const productDataResponse = await admin.graphql(`
      #graphql
      query getProductVariant($id: ID!) {
        product(id: $id) {
          variants(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    `, { variables: { id: productId } });

    const productDataJson = await productDataResponse.json();
    const variantId = productDataJson.data?.product?.variants?.edges[0]?.node?.id;

    if (!variantId) {
      return json({ success: false, error: "No product variants found to modify." });
    }

    // B: Use the updated productVariantsBulkUpdate mutation
    const mutationResponse = await admin.graphql(`
      #graphql
      mutation updateProductVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants {
            id
            price
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      variables: {
        productId: productId, // The parent Product ID
        variants: [
          {
            id: variantId,     // The specific variant ID
            price: newPrice,   // The new price
          }
        ]
      }
    });

    const mutationJson = await mutationResponse.json();
    const errors = mutationJson.data?.productVariantsBulkUpdate?.userErrors;

    if (errors && errors.length > 0) {
      return json({ success: false, error: errors[0].message });
    }

    // Grab the updated price from the bulk array return
    const updatedPrice = mutationJson.data?.productVariantsBulkUpdate?.productVariants[0]?.price;

    return json({ 
      success: true, 
      updatedPrice: updatedPrice 
    });

  } catch (err: any) {
    return json({ success: false, error: err?.message || "Failed to communicate with Shopify backend." });
  }
};

// ==========================================
// 2. THE FRONTEND VIEW (Renders in Admin)
// ==========================================
export default function Index() {
  const fetcher = useFetcher<typeof action>(); 
  
  const isModifying = fetcher.state === "submitting" || fetcher.state === "loading";
  const serverResponse = fetcher.data;

  // Change just the numbers at the end to match your real product ID
  const TARGET_PRODUCT_ID = "gid://shopify/Product/15339596054694"; 

  const handlePriceUpdate = () => {
    fetcher.submit(
      { 
        productId: TARGET_PRODUCT_ID, 
        newPrice: "49.99" 
      }, 
      { method: "POST" }
    );
  };

  return (
    <Page title="Global Store Automations">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Quick Price Sync Manager
              </Text>
              <Text as="p" variant="bodyMd">
                Clicking the sync button below immediately updates your target product's active variant price directly to <strong>$49.99 USD</strong>.
              </Text>

              {serverResponse?.success === true && "updatedPrice" in serverResponse && (
                <Banner tone="success" title="Store modified successfully!">
                  <p>Product variant price updated cleanly to ${serverResponse.updatedPrice} live in the store catalog.</p>
                </Banner>
              )}

              {serverResponse?.success === false && "error" in serverResponse && (
                <Banner tone="critical" title="Modification Failed">
                  <p>{serverResponse.error}</p>
                </Banner>
              )}

              <div>
                <Button 
                  variant="primary" 
                  onClick={handlePriceUpdate}
                  loading={isModifying}
                >
                  {isModifying ? "Updating Live Catalog..." : "Update Target Product Price"}
                </Button>
              </div>

            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}