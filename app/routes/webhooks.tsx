import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. Authenticate the request (Security: ensure it's actually from Shopify)
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  console.log(`Received webhook for ${topic} from ${shop}`);

  // 2. Handle specific topics
  switch (topic) {
    case "PRODUCTS_UPDATE":
      console.log("Product was updated:", payload.id);
      
      // Example: If the product is in your VIP list, update the title automatically
      await db.vipProduct.updateMany({
        where: { productId: `gid://shopify/Product/${payload.id}` },
        data: { title: payload.title }
      });
      break;

    case "APP_UNINSTALLED":
      // Handle cleanup if the merchant deletes your app
      break;

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  // 3. Always return a 200 OK so Shopify doesn't keep retrying
  return new Response();
};