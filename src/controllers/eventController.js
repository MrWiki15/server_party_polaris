import {
  AccountCreateTransaction,
  AccountBalanceQuery,
  TokenCreateTransaction,
  Hbar,
  HbarUnit,
  PrivateKey,
  Key,
  TokenUpdateTransaction,
  Transaction,
  TransferTransaction,
  TokenId,
  Status,
  AccountId,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  TokenMintTransaction,
  TokenInfoQuery,
  ContractId,
  ContractCallQuery,
  AccountInfoQuery,
  TokenAssociateTransaction,
  AccountAllowanceApproveTransaction,
  TokenBurnTransaction,
} from "@hashgraph/sdk";
import supabase from "../db/db.js";
import { getHederaClient } from "../hedera/hederaClient.js";
import { encryptKey, decryptKey } from "../utils/crypto.js";
import Joi from "joi";
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import Long from "long";

// Direcciones de SaucerSwap V2 (Testnet)
const SAUCERSWAP_V2_ROUTER = "0.0.1414040";
const SAUCERSWAP_V2_FACTORY = "0.0.1197038";
const HBAR_SOLIDITY_ADDRESS = "0x0000000000000000000000000000000000000000";

const client = getHederaClient();

export const createEvent = async (req, res, next) => {
  console.log("createEvent");
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

    // 5. Firmar
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

export const updateTokenForEvent = async (req, res, next) => {
  try {
    const { event_id, newName, newDescription, newImage } = req.body;

    if (!event_id || !newName || !newDescription || !newImage) {
      throw new Error("Faltan parámetros requeridos");
    }

    const { data: event, error } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
      .single();

    if (error || !event) throw new Error("Evento no encontrado");
    if (!event.token_id) throw new Error("Token no creado para este evento");

    // 1. Subir imagen a IPFS
    const imageResponse = await axios.get(newImage, {
      responseType: "arraybuffer",
    });
    const __dirname = path.resolve();

    const tempFilePath = path.join(__dirname, "temp-image");
    fs.writeFileSync(tempFilePath, imageResponse.data);

    const imageType = imageResponse.headers["content-type"] || "image/png";
    const imageExt = imageType.split("/")[1] || "png";

    const imageFormData = new FormData();
    imageFormData.append("file", fs.createReadStream(tempFilePath), {
      filename: `event-${event_id}-image.${imageExt}`,
      contentType: imageType,
    });

    const imageUpload = await axios.post(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      imageFormData,
      {
        headers: {
          Authorization: `Bearer ${process.env.PINATA_JWT}`,
          ...imageFormData.getHeaders(),
        },
      }
    );

    const imageCID = imageUpload.data.IpfsHash;
    const imageURI = `ipfs://${imageCID}`;

    // 2. Construir metadata HIP412
    const metadata = {
      format: "HIP412@2.0.0",
      name: newName,
      creator: "Sonnar by Polaris",
      description: newDescription,
      image: imageURI,
      attributes: [
        {
          trait_type: "Event Type",
          value: event.is_online ? "Online" : "Presencial",
        },
        {
          trait_type: "Event Goal",
          value: event.goal_amount,
        },
        {
          trait_type: "Event Date",
          value: event.date,
        },
        {
          trait_type: "Event Location",
          value: event.is_online ? event.address : event.city,
        },
        {
          trait_type: "Event Price",
          value: event.entry_price,
        },
        {
          trait_type: "Event Capacity",
          value: event.capacity,
        },
      ],
      files: [
        {
          uri: imageURI,
          type: imageType,
          is_default_file: true,
        },
      ],
    };

    // 3. Subir metadata a IPFS
    const metadataResponse = await axios.post(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      {
        pinataMetadata: { name: `${event_id}_metadata` },
        pinataContent: metadata,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PINATA_JWT}`,
        },
      }
    );

    const metadataCID = metadataResponse.data.IpfsHash;

    // Eliminar archivo temporal
    fs.unlinkSync(tempFilePath);

    // 4. Actualizar token en Hedera
    const operatorKey = PrivateKey.fromString(
      decryptKey(event.parti_wallet_private_key)
    );
    const client = getHederaClient().setOperator(
      event.parti_wallet,
      operatorKey
    );

    const ipfsBytes = new TextEncoder().encode(metadataCID);
    if (ipfsBytes.length > 100)
      throw new Error("El hash IPFS excede el límite de 100 bytes");

    const transaction = await new TokenUpdateTransaction()
      .setTokenId(TokenId.fromString(event.token_id))
      .setMetadata(ipfsBytes)
      .freezeWith(client);

    transaction.sign(operatorKey);
    transaction.sign(
      PrivateKey.fromString(decryptKey(event.token_admin_private_key))
    );

    const txResponse = await transaction.execute(client);
    const receipt = await txResponse.getReceipt(client);

    if (receipt.status !== Status.Success) {
      throw new Error(`Transacción fallida: ${receipt.status}`);
    }

    // 5. Actualizar base de datos
    const { error: updateError } = await supabase
      .from("parties")
      .update({
        token_metadata: metadataCID,
        updated_at: new Date().toISOString(),
      })
      .eq("id", event_id);

    if (updateError) throw updateError;

    res.status(200).json({
      success: true,
      message: "Token actualizado correctamente",
      ipfsHash: metadataCID,
      tokenId: event.token_id,
      imageCID,
    });
  } catch (e) {
    console.error("Error en updateTokenForEvent:", e);
    next(new Error(`Error al actualizar el token: ${e.message}`));
  }
};

export const createLiquidityPool = async (req, res, next) => {
  let client;
  let operatorKey;
  let tokenId;
  let tokenAmountScaled;

  const {
    event_id,
    token_amount: tokenAmountStr,
    hbar_amount: hbarAmountStr,
    fee_tier = "3000",
    slippage = "1",
  } = req.body;

  try {
    // 1. Validación inicial
    if (!event_id || !tokenAmountStr || !hbarAmountStr) {
      throw new Error("Parámetros requeridos faltantes");
    }

    const slippageValue = parseFloat(slippage);
    if (isNaN(slippageValue) || slippageValue < 0 || slippageValue >= 100) {
      throw new Error("Slippage debe estar entre 0 y 99.99");
    }

    // 2. Obtener datos del evento
    const { data: event, error: eventError } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
      .single();

    if (eventError || !event) throw new Error("Evento no encontrado");
    if (!event.token_id) throw new Error("Token no creado para este evento");
    if (!event.token_supply_private_key) {
      throw new Error("Clave de suministro no configurada");
    }

    // 3. Configurar cliente Hedera
    client = getHederaClient();
    console.log("private key --------------------------");
    console.log(decryptKey(event.parti_wallet_private_key));
    operatorKey = PrivateKey.fromString(
      decryptKey(event.parti_wallet_private_key)
    );
    client.setOperator(event.parti_wallet, operatorKey);

    const suppley_toke_key = decryptKey(event.token_supply_private_key);
    console.log("private key --------------------------");
    console.log(suppley_toke_key);

    // 4. Obtener información del token
    tokenId = TokenId.fromString(event.token_id);
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);

    const tokenDecimals = tokenInfo.decimals;

    // 5. Conversión precisa de montos
    const tokenAmount = parseFloat(tokenAmountStr);
    tokenAmountScaled = Long.fromNumber(
      Math.round(tokenAmount * 10 ** tokenDecimals)
    );

    const hbarAmount = parseFloat(hbarAmountStr);
    const hbarTinybars = Long.fromString(
      Math.round(hbarAmount * 1e8).toString()
    );

    // 6. Validación de montos
    if (tokenAmountScaled.isZero() || hbarTinybars.isZero()) {
      throw new Error("Los montos no pueden ser cero");
    }

    // 7. Ordenar tokens
    const tokenAddress = tokenId.toSolidityAddress();
    const hbarAddress = HBAR_SOLIDITY_ADDRESS;

    let amountADesired, amountBDesired;
    const [tokenA, tokenB] =
      tokenAddress < hbarAddress
        ? [tokenAddress, hbarAddress]
        : [hbarAddress, tokenAddress];

    if (tokenAddress < hbarAddress) {
      amountADesired = tokenAmountScaled;
      amountBDesired = hbarTinybars;
    } else {
      amountADesired = hbarTinybars;
      amountBDesired = tokenAmountScaled;
    }

    // 8. Calcular montos mínimos
    const slippageFactor = 100 - slippageValue;
    const amountAMin = amountADesired
      .multiply(slippageFactor)
      .divide(100)
      .toString();
    const amountBMin = amountBDesired
      .multiply(slippageFactor)
      .divide(100)
      .toString();

    // 9. Aprobación de tokens (corregido)
    const routerAccountId = AccountId.fromString(SAUCERSWAP_V2_ROUTER);
    const approveTx = await new AccountAllowanceApproveTransaction()
      .approveTokenAllowance(
        tokenId,
        client.operatorAccountId,
        routerAccountId,
        tokenAmountScaled
      )
      .freezeWith(client)
      .sign(operatorKey);

    const approveResponse = await approveTx.execute(client);
    const approveReceipt = await approveResponse.getReceipt(client);

    if (approveReceipt.status !== Status.Success) {
      throw new Error(`Fallo en aprobación: ${approveReceipt.status}`);
    }

    // 10. Configurar parámetros de liquidez
    const liquidityParams = new ContractFunctionParameters()
      .addAddress(tokenA)
      .addAddress(tokenB)
      .addUint256(amountADesired.toString())
      .addUint256(amountBDesired.toString())
      .addUint256(amountAMin)
      .addUint256(amountBMin)
      .addAddress(client.operatorAccountId.toSolidityAddress())
      .addUint256(Math.floor(Date.now() / 1000) + 1800);

    // 11. Ejecutar transacción de liquidez
    const liquidityTx = await new ContractExecuteTransaction()
      .setPayableAmount(
        Hbar.fromTinybars(
          tokenA === hbarAddress ? amountADesired : amountBDesired
        )
      )
      .setContractId(ContractId.fromString(SAUCERSWAP_V2_ROUTER))
      .setGas(5_000_000)
      .setFunction("addLiquidityETHNewPool", liquidityParams)
      .execute(client);

    const liquidityResponse = await liquidityTx.getRecord(client);

    liquidityResponse.receipt.status !== Status.Success &&
      console.log(liquidityResponse.receipt.status);

    // 12. Obtener dirección del pool
    const poolQuery = await new ContractCallQuery()
      .setContractId(ContractId.fromString(SAUCERSWAP_V2_FACTORY))
      .setGas(500_000)
      .setFunction(
        "getPool",
        new ContractFunctionParameters()
          .addAddress(tokenA)
          .addAddress(tokenB)
          .addUint24(Number(fee_tier))
      )
      .execute(client);

    const poolAddress = poolQuery.getAddress(0);
    if (!poolAddress) throw new Error("Dirección del pool no obtenida");

    // 13. Actualizar base de datos
    const { error: updateError } = await supabase
      .from("parties")
      .update({
        liquidity_pool: true,
        pool_id: poolAddress,
        total_supply: (event.total_supply || 0) + tokenAmount,
        pool_url: `https://app.saucerswap.finance/pool/${poolAddress}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", event_id);

    if (updateError) throw updateError;

    res.status(200).json({
      success: true,
      message: "Pool creado exitosamente",
      data: {
        token_minted: tokenAmount,
        hbar_provided: hbarAmount,
        pool_address: poolAddress,
        saucerswap_url: `https://app.saucerswap.finance/pool/${poolAddress}`,
        transaction_id: liquidityReceipt.transactionId.toString(),
      },
    });
  } catch (e) {
    console.error("Error en createLiquidityPool:", e);
    next(new Error(`Error al crear liquidez: ${e.message}`));
  } finally {
    if (client) await client.close();
  }
};

export const windrawMoney = async () => {
  try {
    const { event_id, user_wallet } = req.body;

    const { data, error } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
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

    //crear memo
    const memo = `windraw money from sonnar app -> https://sonnar.club -> ${new Date().toISOString()}`;

    // Configurar cliente
    const operatorKey = PrivateKey.fromString(
      decryptKey(data.parti_wallet_private_key)
    );

    const client = getHederaClient().setOperator(
      data.parti_wallet,
      operatorKey
    );

    const transaction = await new TransferTransaction()
      .addHbarTransfer(
        AccountId.fromString(data.parti_wallet),
        Hbar.from(-amount, HbarUnit.Hbar)
      )
      .addHbarTransfer(
        AccountId.fromString(user_wallet),
        Hbar.from(amount, HbarUnit.Hbar)
      )
      .setTransactionMemo(memo)
      .freezeWith(client);

    const transferResponse = await transaction.execute(client);
    const transferReceipt = await transferResponse.getReceipt(client);

    console.log(`Retito completado:`, transferReceipt.status.toString());

    res({
      success: true,
      transactionId: transferResponse.transactionId.toString(),
      tokensReceived: amount,
    });
  } catch (e) {
    console.error("Error en windrawMoney: ", e);
    next(
      new Error(`Error retirar dinero de la wallet del parti: ${e.message}`)
    );
  }
};
