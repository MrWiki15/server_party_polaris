import {
  AccountCreateTransaction,
  AccountBalanceQuery,
  TokenCreateTransaction,
  Hbar,
  HbarUnit,
  PrivateKey,
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
    console.log(event_id);

    const { data, error } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
      .single();

    console.log(data);

    const eventClient = getHederaClient().setOperator(
      data.parti_wallet,
      PrivateKey.fromString(decryptKey(data.parti_wallet_private_key))
    );

    const tokenTx = await new TokenCreateTransaction()
      .setTokenName(data.name)
      .setTokenSymbol(data.name.slice(0, 3).toUpperCase())
      .setDecimals(2)
      .setInitialSupply(0)
      .setTreasuryAccountId(data.parti_wallet)
      .freezeWith(eventClient)
      .execute(eventClient);

    const tokenId = (await tokenTx.getReceipt(eventClient)).tokenId;

    await supabase
      .from("parties")
      .update({ token_id: tokenId.toString() })
      .eq("id", event_id);

    res.json({
      success: true,
      tokenId: tokenId.toString(),
    });
  } catch (error) {
    next(new Error(`Error creando token: ${error.message}`));
  }
};
