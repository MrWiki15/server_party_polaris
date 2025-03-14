import {
  TransferTransaction,
  TokenMintTransaction,
  PrivateKey,
} from "@hashgraph/sdk";
import supabase from "../db/db.js";
import { getHederaClient } from "../hedera/hederaClient.js";
import { decryptKey } from "../utils/crypto.js";

export const donateToEvent = async (req, res, next) => {
  try {
    const { donation_id, event_id, donor_wallet, amount_hbar } = req.body;

    // 1. Obtener datos del evento
    const { data: event, error: eventError } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
      .single();

    if (!event || eventError) {
      throw new Error("Evento no encontrado");
    }

    // 2. Configurar cliente Hedera
    const operatorKey = PrivateKey.fromString(
      decryptKey(event.parti_wallet_private_key)
    );

    const client = getHederaClient().setOperator(
      event.parti_wallet,
      operatorKey
    );

    // 3. Obtener y preparar claves necesarias
    const supplyKey = PrivateKey.fromString(
      decryptKey(event.token_supply_private_key)
    );

    const decimals = 2;
    const tokensToMint = (Number(amount_hbar) / 2) * Math.pow(10, decimals);

    // 4. Mintear tokens con supply key
    const mintTx = await new TokenMintTransaction()
      .setTokenId(event.token_id)
      .setAmount(tokensToMint)
      .freezeWith(client);

    const signedMintTx = await mintTx.sign(supplyKey);
    const mintResponse = await signedMintTx.execute(client);
    const mintReceipt = await mintResponse.getReceipt(client);

    console.log(
      `Tokens minteados: ${tokensToMint}`,
      mintReceipt.status.toString()
    );

    // 5. Transferir tokens al donante
    const transferTx = await new TransferTransaction()
      .addTokenTransfer(event.token_id, event.parti_wallet, -tokensToMint)
      .addTokenTransfer(event.token_id, donor_wallet, tokensToMint)
      .freezeWith(client);

    const transferResponse = await transferTx.execute(client);
    const transferReceipt = await transferResponse.getReceipt(client);

    console.log(`Transferencia completada:`, transferReceipt.status.toString());

    // 6. Actualizar base de datos
    await supabase
      .from("donations")
      .update({
        partie_id: event_id,
        donator_id: donor_wallet,
        amount: amount_hbar,
        tokens_recived: tokensToMint,
        transaction_id: transferResponse.transactionId.toString(),
        status: 2,
      })
      .eq("id", donation_id);

    await supabase
      .from("parties")
      .update({
        collected_amount: (event.collected_amount || 0) + Number(amount_hbar),
        donations: [...(event.donations || []), donation_id],
        updated_at: new Date().toISOString(),
      })
      .eq("id", event_id);

    res.json({
      success: true,
      transactionId: transferResponse.transactionId.toString(),
      tokensReceived: tokensToMint,
    });
  } catch (error) {
    console.error("Error en donateToEvent:", error);
    next(new Error(`Error en donación: ${error.message}`));
  }
};
