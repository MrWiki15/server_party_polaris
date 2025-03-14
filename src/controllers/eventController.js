import {
  AccountCreateTransaction,
  AccountBalanceQuery,
  TokenCreateTransaction,
  Hbar,
  HbarUnit,
  PrivateKey,
  Key,
} from "@hashgraph/sdk";
import supabase from "../db/db.js";
import { getHederaClient } from "../hedera/hederaClient.js";
import { encryptKey, decryptKey } from "../utils/crypto.js";
import Joi from "joi";

const client = getHederaClient();

export const createEvent = async (req, res, next) => {
  try {
    const { event_id, organizer_wallet } = req.body;

    const { data: existingEvent } = await supabase
      .from("parties")
      .select("parti_wallet")
      .eq("id", event_id)
      .single();

    if (existingEvent?.parti_wallet) {
      return res
        .status(400)
        .json({ error: "El evento ya tiene una wallet asociada" });
    }

    const newPrivateKey = PrivateKey.generateED25519();
    const transaction = await new AccountCreateTransaction()
      .setKey(newPrivateKey.publicKey)
      .setInitialBalance(Hbar.from(0))
      .execute(client);

    const receipt = await transaction.getReceipt(client);
    const newAccountId = receipt.accountId.toString();

    await supabase
      .from("parties")
      .update({
        parti_wallet: newAccountId,
        parti_wallet_private_key: encryptKey(newPrivateKey.toString()),
      })
      .eq("id", event_id);

    res.json({
      success: true,
      wallet: newAccountId,
    });
  } catch (error) {
    next(new Error(`Error al crear evento: ${error.message}`));
  }
};

export const checkWalletFunding = async (req, res, next) => {
  try {
    const { event_id } = req.body;

    // Validar entrada
    if (!event_id) {
      return res.status(400).json({ error: "event_id es requerido" });
    }

    // Obtener wallet del evento
    const { data: event, error } = await supabase
      .from("parties")
      .select("parti_wallet")
      .eq("id", event_id)
      .single();

    if (!event?.parti_wallet) {
      return res.status(404).json({ error: "Wallet del evento no encontrada" });
    }

    // Consultar balance
    const balance = await new AccountBalanceQuery()
      .setAccountId(event.parti_wallet)
      .execute(client);

    // Convertir a Hbar
    const hbarBalance = Hbar.from(balance.hbars.toTinybars()); // Tinybars → Hbar
    const requiredBalance = Hbar.from(10, HbarUnit.Hbar); // 20 HBAR

    // Comparar valores numéricos
    if (
      hbarBalance.to(HbarUnit.Hbar).toNumber() <
      requiredBalance.to(HbarUnit.Hbar).toNumber()
    ) {
      return res.status(402).json({
        funded: false,
        required: "10 ℏ",
        current: hbarBalance.toString(),
      });
    }

    res.json({ funded: true });
  } catch (error) {
    next(new Error(`Error verificando fondo: ${error.message}`));
  }
};

export const createTokenForEvent = async (req, res, next) => {
  try {
    const { event_id } = req.body;

    // 1. Obtener evento
    const { data, error } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
      .single();
    if (!data || error) throw new Error("Evento no encontrado");

    // 2. Configurar cliente
    const operatorKey = PrivateKey.fromString(
      decryptKey(data.parti_wallet_private_key)
    );
    const client = getHederaClient().setOperator(
      data.parti_wallet,
      operatorKey
    );

    // 3. Generar claves
    const supplyKey = PrivateKey.generateED25519();
    const adminKey = PrivateKey.generateED25519();
    const metadataKey = PrivateKey.generateED25519();

    // 4. Construir transacción
    const transaction = await new TokenCreateTransaction()
      .setTokenName(data.name)
      .setTokenSymbol(data.name.slice(0, 3).toUpperCase())
      .setDecimals(2)
      .setInitialSupply(0)
      .setTreasuryAccountId(data.parti_wallet)
      .setSupplyKey(supplyKey.publicKey)
      .setAdminKey(adminKey.publicKey)
      .setMetadataKey(metadataKey.publicKey)
      .freezeWith(client);

    // 5. Firmar correctamente (sin encadenamiento)
    transaction.sign(operatorKey);
    transaction.sign(supplyKey);
    transaction.sign(adminKey);
    transaction.sign(metadataKey);

    // 6. Ejecutar
    const tokenTx = await transaction.execute(client);
    const tokenId = (await tokenTx.getReceipt(client)).tokenId;

    // 7. Guardar en BD
    await supabase
      .from("parties")
      .update({
        token_id: tokenId.toString(),
        token_supply_public_key: supplyKey.publicKey.toString(),
        token_supply_private_key: encryptKey(supplyKey.toString()),
        token_admin_public_key: adminKey.publicKey.toString(),
        token_admin_private_key: encryptKey(adminKey.toString()),
        token_metadata_public_key: metadataKey.publicKey.toString(),
        token_metadata_private_key: encryptKey(metadataKey.toString()),
      })
      .eq("id", event_id);

    res.json({ success: true, tokenId: tokenId.toString() });
  } catch (error) {
    console.error("Error en createTokenForEvent:", error);
    next(new Error(`Error creando token: ${error.message}`));
  }
};
