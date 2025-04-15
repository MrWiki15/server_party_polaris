//testing para probar las claves

import { decryptKey } from "./crypto.js";
import supabase from "../db/db.js";

const main = async (eventId) => {
  const { data, error } = await supabase
    .from("parties")
    .select("*")
    .eq("id", eventId)
    .single();
  if (!data || error) throw new Error("Evento no encontrado");
  if (!data.parti_wallet)
    throw new Error(
      "Wallet del evento no encontrada, complete el setup para continuar"
    );
  if (!data.parti_wallet_private_key)
    throw new Error(
      "Token no tiene el setup completado, complete el setup para poder retirar dinero"
    );

  const privateKey = decryptKey(data.parti_wallet_private_key);
  console.log(privateKey);
};

main("dc0ce13a-e1f7-4443-9f91-b3a15da7d01f");
