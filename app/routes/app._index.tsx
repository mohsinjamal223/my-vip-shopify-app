import { useState } from "react";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Button, BlockStack, Text, List } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// LOAD DATA: Get the list of VIP products from our database
export const loader = async ({ request }: any) => {
  await authenticate.admin(request);
  const vipProducts = await db.vipProduct.findMany();
  return json({ vipProducts });
};

// ACTION DATA: Save the selected product to our database
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const productId = formData.get("productId") as string;
  const intent = formData.get("_action"); // Check if we want to delete

  // --- LOGIC FOR REMOVING ---
  if (intent === "DELETE") {
    // 1. Remove from Prisma
    await db.vipProduct.delete({
      where: { productId },
    });

    // 2. Remove the Metafield from Shopify
    // We set the value to 'false' (or you can use metafieldDelete)
    await admin.graphql(`
      mutation {
        metafieldsSet(metafields: [{
          ownerId: "${productId}",
          namespace: "custom",
          key: "vip_status",
          value: "false",
          type: "boolean"
        }]) {
          metafields { id }
        }
      }
    `);

    return json({ success: true });
  }

  // --- LOGIC FOR ADDING (Existing code) ---
  const title = formData.get("title") as string;
  await db.vipProduct.upsert({
    where: { productId },
    update: { title },
    create: { productId, title },
  });

  await admin.graphql(`
    mutation {
      metafieldsSet(metafields: [{
        ownerId: "${productId}",
        namespace: "custom",
        key: "vip_status",
        value: "true",
        type: "boolean"
      }]) {
        metafields { id }
      }
    }
  `);

  return json({ success: true });
};

export default function Index() {
  const { vipProducts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  // This function opens the native Shopify product selector
  const selectProduct = async () => {
    const selected = await window.shopify.resourcePicker({
      type: "product",
      multiple: false, // We only want one VIP product for this test
    });

    if (selected && selected.length > 0) {
      const { id, title } = selected[0];
      
      // Send the selection to our server-side action
      fetcher.submit(
        { productId: id, title: title },
        { method: "POST" }
      );
    }
  };

  return (
    <Page title="VIP Badge Manager">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <Text as="h2" variant="headingMd">
                Select a VIP Product
              </Text>
              <Text as="p" variant="bodyMd">
                Choose a product that should display a special badge on your storefront.
              </Text>
              
              <Button variant="primary" onClick={selectProduct}>
                Open Product Picker
              </Button>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">Current VIP Products</Text>
              <Text as="h3" variant="headingSm">Active VIPs:</Text>
              {vipProducts.length === 0 ? (
                <Text as="p" tone="subdued">No VIP products selected yet.</Text>
              ) : (
                <List>
                  
{vipProducts.map((product) => (
  <List.Item key={product.id}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '300px' }}>
      {product.title}
      
      <Button
        tone="critical" 
        variant="tertiary"
        onClick={() => fetcher.submit({ productId: product.productId, _action: "DELETE" }, { method: "POST" })}
      >
        Remove
      </Button>
    </div>
  </List.Item>
))}
                </List>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}