import { store } from "../store/memory.js";
import { processTextMessage } from "../processors/router.js";
import assert from "assert";

async function runTests() {
  console.log("=== Running NLP / Messaging Fixes Verification ===");

  // Reset database first
  store.resetDb();
  
  // Update business prefix for tests
  store.updateBusiness({ prefix: "RAM", name: "Ram Wholesale" });
  
  const ownerNumber = "+919876500001";
  store.setTrustedNumbers([ownerNumber]);

  // Test case 1: "amit stores paid 5000 upi" (Unmatched client, no new keyword)
  console.log("Test 1: Unmatched client without 'new' keyword...");
  const res1 = await processTextMessage("amit stores paid 5000 upi", {
    sourceNumber: ownerNumber,
    messageType: "text",
    timestamp: Date.now()
  });
  
  assert.strictEqual(res1.transaction.status, "pending_review", "Status must be pending_review");
  assert.strictEqual(res1.transaction.client_id, null, "client_id must be null");
  assert.strictEqual(res1.transaction.client_name, "amit stores", "Client name should match extracted name");
  assert.strictEqual(res1.transaction.review_reason, "client not registered", "Review reason must be 'client not registered'");
  const clientsBefore = store.listClients();
  assert.ok(!clientsBefore.some(c => c.name.toLowerCase().includes("amit stores")), "Should not have created client 'amit stores'");
  console.log("✓ Test 1 Passed!");

  // Test case 2: "@ new Amit Traders took goods worth 30000" (Unmatched client with 'new' keyword)
  console.log("Test 2: Client creation with '@ new' keyword...");
  const res2 = await processTextMessage("@ new Amit Traders took goods worth 30000", {
    sourceNumber: ownerNumber,
    messageType: "text",
    timestamp: Date.now()
  });
  
  // Note: credit_days is missing, so status is pending_review
  assert.strictEqual(res2.transaction.status, "pending_review", "Status must be pending_review due to missing credit days");
  assert.strictEqual(res2.transaction.review_reason, "credit period (days) not specified", "Review reason must be correct");
  assert.ok(res2.transaction.client_id !== null, "client_id must be assigned");
  
  const createdClient = store.getClient(res2.transaction.client_id);
  assert.ok(createdClient, "Client should exist in database");
  assert.strictEqual(createdClient.name, "Amit Traders", "Client name must be cleaned of prefix/new");
  console.log("✓ Test 2 Passed!");

  // Test case 3: "Amit Traders phone number +91 76583912657" (Client phone update)
  console.log("Test 3: Update client phone number...");
  const res3 = await processTextMessage("Amit Traders phone number +91 76583912657", {
    sourceNumber: ownerNumber,
    messageType: "text",
    timestamp: Date.now()
  });
  
  assert.strictEqual(res3.client_updated, true, "Should return client_updated flag");
  assert.strictEqual(res3.client.name, "Amit Traders", "Should match the client");
  assert.strictEqual(res3.client.phone, "+9176583912657", "Phone number should be formatted and updated");
  
  const updatedClient = store.getClient(res2.transaction.client_id);
  assert.strictEqual(updatedClient.phone, "+9176583912657", "Updated phone must persist in store");
  console.log("✓ Test 3 Passed!");

  // Test case 4: "Amit Traders took goods worth 30000" (Existing client, missing credit days)
  console.log("Test 4: Goods transaction with missing credit days...");
  const res4 = await processTextMessage("Amit Traders took goods worth 30000", {
    sourceNumber: ownerNumber,
    messageType: "text",
    timestamp: Date.now()
  });
  
  assert.strictEqual(res4.transaction.status, "pending_review", "Status must be pending_review due to missing credit days");
  assert.strictEqual(res4.transaction.review_reason, "credit period (days) not specified", "Review reason must be correct");
  assert.strictEqual(res4.transaction.client_id, res2.transaction.client_id, "Should match existing client ID");
  console.log("✓ Test 4 Passed!");
  
  // Test case 5: "RAM Amit Traders took goods worth 30000 for 40 days" (Existing client, has credit days)
  console.log("Test 5: Goods transaction with credit days specified...");
  const res5 = await processTextMessage("RAM Amit Traders took goods worth 30000 for 40 days", {
    sourceNumber: ownerNumber,
    messageType: "text",
    timestamp: Date.now()
  });
  
  assert.strictEqual(res5.transaction.status, "confirmed", "Status must be confirmed when credit days and client match");
  assert.strictEqual(res5.transaction.credit_days, 40, "Credit days should be 40");
  console.log("✓ Test 5 Passed!");

  console.log("=== All Verification Tests Passed Successfully! ===");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
