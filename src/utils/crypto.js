import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

export const validateEncryptionKey = () => {
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY no configurada en .env");
  }

  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY debe ser 64 caracteres hex (32 bytes)");
  }
};

export const encryptKey = (privateKey) => {
  validateEncryptionKey();

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(process.env.ENCRYPTION_KEY, "hex"),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(privateKey, "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([encrypted, iv]).toString("base64");
};

export const decryptKey = (encryptedKeyBase64) => {
  validateEncryptionKey();

  try {
    const encryptedKey = Buffer.from(encryptedKeyBase64, "base64");

    if (encryptedKey.length < 16) {
      throw new Error("Datos cifrados inválidos");
    }

    const iv = encryptedKey.slice(-16);
    const encryptedData = encryptedKey.slice(0, -16);

    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(process.env.ENCRYPTION_KEY, "hex"),
      iv
    );

    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ]);

    console.log("private_key descriptada");
    console.log(decrypted.toString("utf-8"));
    return decrypted.toString("utf8");
  } catch (error) {
    throw new Error(`Error de descifrado: ${error.message}`);
  }
};
