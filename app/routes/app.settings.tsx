import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Checkbox,
  BlockStack,
  InlineStack,
  Button,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

export default function Settings() {
  // 1. Manage state for form inputs
  const [discountValue, setDiscountValue] = useState("10");
  const [isAppEnabled, setIsAppEnabled] = useState(true);
  const [customNote, setCustomNote] = useState("Thank you for shopping with us!");

  // 2. Handle saving actions
  const handleSave = () => {
    alert("Settings saved successfully!");
    // Here we will eventually send data to the backend using Remix `useSubmit()`
  };

  return (
    <Page>
      <TitleBar title="Settings" />
      
      <Layout>
        {/* Main Left Column (Form Options) */}
        <Layout.Section>
          <BlockStack gap="500">
            
            {/* Card 1: Configuration Fields */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  General Configurations
                </Text>
                
                <FormLayout>
                  <TextField
                    label="Default Discount Percentage"
                    type="number"
                    value={discountValue}
                    onChange={(value) => setDiscountValue(value)}
                    suffix="%"
                    autoComplete="off"
                  />
                  
                  <TextField
                    label="Custom Cart Banner Text"
                    type="text"
                    value={customNote}
                    onChange={(value) => setCustomNote(value)}
                    multiline={2}
                    autoComplete="off"
                  />
                </FormLayout>
              </BlockStack>
            </Card>

            {/* Card 2: Status Toggles */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  App Status
                </Text>
                <Checkbox
                  label="Enable app injection on checkout storefront pages"
                  checked={isAppEnabled}
                  onChange={(newChecked) => setIsAppEnabled(newChecked)}
                />
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>

        {/* Right Side Column (Summary / System Details) */}
        <Layout.Section variant="oneThird">
          <Card background="bg-surface-secondary">
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">
                Integration Info
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Current Status: <strong>{isAppEnabled ? "Active" : "Disabled"}</strong>
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Prisma Synced: <strong>Yes</strong>
              </Text>
              <hr style={{ border: "none", borderTop: "1px solid #e1e3e5" }} />
              <InlineStack align="end">
                <Button variant="primary" onClick={handleSave}>
                  Save Configurations
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}