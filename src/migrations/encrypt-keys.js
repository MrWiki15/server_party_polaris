import supabase from "../src/db/db.js";
import { encryptKey } from "../src/utils/crypto.js";

const migrateKeys = async () => {
  const { data: parties, error } = await supabase
    .from("parties")
    .select("id, parti_wallet_private_key");

  if (error) throw error;

  for (const party of parties) {
    try {
      const decryptedKey = Buffer.from(
        party.parti_wallet_private_key,
        "base64"
      ).toString();
      const encryptedKey = encryptKey(decryptedKey);

      await supabase
        .from("parties")
        .update({ parti_wallet_private_key: encryptedKey })
        .eq("id", party.id);
    } catch (error) {
      console.error(`Error migrando party ${party.id}:`, error.message);
    }
  }
};

migrateKeys()
  .then(() => console.log("✅ Migración completada"))
  .catch((err) => console.error("❌ Error en migración:", err));
