import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveAccessKeyMaterial,
  decryptBytes,
  decryptJsonValue,
  deriveX25519SharedSecret,
  base64UrlDecode,
  base64UrlEncode,
  encryptBytes,
  encryptJsonValue,
  exportX25519PrivateKey,
  exportX25519PublicKey,
  generateX25519KeyPair,
  importX25519PrivateKey,
  importX25519PublicKey,
  normalizeKeyText
} from "../frontend/lib/privmsg.js";

test("round-trips enhanced-encryption helpers with X25519", async () => {
  const messageId = "test-message-id-0123456789";
  const recipientKeyPair = await generateX25519KeyPair();
  const senderKeyPair = await generateX25519KeyPair();

  const recipientPublicKey = await exportX25519PublicKey(recipientKeyPair.publicKey);
  const recipientPrivateKeyBytes = await exportX25519PrivateKey(recipientKeyPair.privateKey);
  const importedRecipientPublicKey = await importX25519PublicKey(normalizeKeyText(`  ${recipientPublicKey}\n`));
  const importedRecipientPrivateKey = await importX25519PrivateKey(recipientPrivateKeyBytes);

  const senderSecret = await deriveX25519SharedSecret(senderKeyPair.privateKey, importedRecipientPublicKey);
  const recipientSecret = await deriveX25519SharedSecret(importedRecipientPrivateKey, senderKeyPair.publicKey);

  assert.deepEqual(Array.from(senderSecret), Array.from(recipientSecret));

  const payload = {
    message: "secret message",
    attachments: [{ index: 0, name: "note.txt", type: "text/plain", size: 12 }]
  };
  const encryptedPayload = await encryptJsonValue(payload, senderSecret, messageId, "x25519:payload");
  const decryptedPayload = await decryptJsonValue(
    encryptedPayload.ciphertext,
    encryptedPayload.iv,
    recipientSecret,
    messageId,
    "x25519:payload"
  );

  assert.deepEqual(decryptedPayload, payload);

  const plaintextBytes = new TextEncoder().encode("top secret attachment");
  const encryptedBytes = await encryptBytes(plaintextBytes, senderSecret, messageId, "x25519:file:0");
  const decryptedBytes = await decryptBytes(encryptedBytes.ciphertext, encryptedBytes.iv, recipientSecret, messageId, "x25519:file:0");

  assert.equal(new TextDecoder().decode(decryptedBytes), "top secret attachment");
});

test("derives stable outer key material from local and server key shares", async () => {
  const messageId = "test-message-id-0123456789";
  const localKeyShare = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const serverKeyShare = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

  const first = await deriveAccessKeyMaterial(base64UrlDecode(localKeyShare), base64UrlDecode(serverKeyShare), messageId);
  const second = await deriveAccessKeyMaterial(base64UrlDecode(localKeyShare), base64UrlDecode(serverKeyShare), messageId);

  assert.equal(first.byteLength, 32);
  assert.deepEqual(Array.from(first), Array.from(second));
});
