import { TransferTransaction, TokenMintTransaction } from "@hashgraph/sdk";
import supabase from "../db/db.js";
import { getHederaClient } from "../hedera/hederaClient.js";
import { decryptKey } from "../utils/crypto.js";

export const donateToEvent = async (req, res, next) => {
  try {
    const { event_id, donor_wallet, amount_hbar } = req.body;

    const { data: event } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
      .single();

    const eventClient = getHederaClient().setOperator(
      event.parti_wallet,
      PrivateKey.fromString(decryptKey(event.parti_wallet_private_key))
    );

    const tokensToMint = (amount_hbar / 2).toFixed(2);

    // Mintear tokens
    const mintTx = await new TokenMintTransaction()
      .setTokenId(event.token_id)
      .setAmount(tokensToMint)
      .freezeWith(eventClient)
      .execute(eventClient);

    await mintTx.getReceipt(eventClient);

    // Transferir tokens
    const transferTx = await new TransferTransaction()
      .addTokenTransfer(event.token_id, event.parti_wallet, -tokensToMint)
      .addTokenTransfer(event.token_id, donor_wallet, tokensToMint)
      .freezeWith(eventClient)
      .execute(eventClient);

    await transferTx.getReceipt(eventClient);

    // Registrar en base de datos
    await supabase
      .from("donations")
      .insert({
        event_id,
        donor_wallet,
        amount_hbar,
        tokens_minted: tokensToMint,
        transaction_id: transferTx.transactionId.toString(),
      })
      .eq("partie_id", event_id);

    res.json({
      success: true,
      transactionId: transferTx.transactionId.toString(),
      tokensReceived: tokensToMint,
    });
  } catch (error) {
    next(new Error(`Error en donación: ${error.message}`));
  }
};
