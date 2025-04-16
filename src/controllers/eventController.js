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
  AccountUpdateTransaction,
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
  // Constantes de la aplicación
  const SAUCERSWAP_V1_ROUTER = "0.0.19264";
  const SAUCERSWAP_V1_FACTORY = "0.0.9959";
  const WHBAR_TOKEN_ID = "0.0.15057"; // Testnet WHBAR
  const WHBAR_SOLIDITY_ADDRESS =
    TokenId.fromString(WHBAR_TOKEN_ID).toSolidityAddress();
  const ZERO_ADDRESS = "0000000000000000000000000000000000000000";

  // Extraer y validar parámetros de entrada
  const { event_id, token_amount, hbar_amount, slippage = "1" } = req.body;
  try {
    if (!event_id || !token_amount || !hbar_amount) {
      throw new Error("Missing required parameters");
    }
    const slippageValue = parseFloat(slippage);
    if (isNaN(slippageValue) || slippageValue < 0 || slippageValue >= 100) {
      throw new Error("Invalid slippage value");
    }

    // Obtenemos el evento (y por ende la información del token) desde la DB
    const { data: event } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
      .single();

    if (!event?.token_id) throw new Error("Event or token not found");

    // Configuración del cliente Hedera y asignación del operador
    client = getHederaClient();
    const operatorKey = PrivateKey.fromString(
      decryptKey(event.parti_wallet_private_key)
    );
    client.setOperator(event.parti_wallet, operatorKey);

    // Convertir montos: se consulta la información del token para obtener los decimales
    const tokenId = TokenId.fromString(event.token_id);
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokenId)
      .execute(client);
    const tokenDecimals = tokenInfo.decimals;

    const tokenAmountScaled = Long.fromNumber(
      Math.round(token_amount * 10 ** tokenDecimals)
    );
    const hbarTinybars = Long.fromNumber(Math.round(hbar_amount * 1e8)); // 1 HBAR = 1e8 tinybars

    // Aprobación de allowance: se autoriza al router a gastar tokens en nombre del operador
    const approveTx = await new AccountAllowanceApproveTransaction()
      .approveTokenAllowance(
        tokenId,
        client.operatorAccountId,
        AccountId.fromString(SAUCERSWAP_V1_ROUTER),
        tokenAmountScaled
      )
      .freezeWith(client)
      .sign(operatorKey);
    await (await approveTx.execute(client)).getReceipt(client);

    // Verificar si existe ya el pool utilizando el factory
    const poolCheckQuery = new ContractCallQuery()
      .setContractId(ContractId.fromString(SAUCERSWAP_V1_FACTORY))
      .setGas(5_000_000)
      .setFunction(
        "getPair",
        new ContractFunctionParameters()
          .addAddress(tokenId.toSolidityAddress())
          .addAddress(WHBAR_SOLIDITY_ADDRESS) // Usar WHBAR aquí
      );
    const poolCheckResponse = await poolCheckQuery.execute(client);
    const poolExists = poolCheckResponse.getAddress(0) !== ZERO_ADDRESS;
    let poolAddress = poolCheckResponse.getAddress(0);

    // Calcular montos mínimos aplicando slippage
    const minTokenAmount = tokenAmountScaled
      .multiply(100 - slippageValue)
      .divide(100);
    const minHbarAmount = hbarTinybars
      .multiply(100 - slippageValue)
      .divide(100);

    // Construir parámetros para la función de liquidez
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const liquidityParams = new ContractFunctionParameters()
      .addAddress(tokenId.toSolidityAddress())
      .addUint256(tokenAmountScaled.toString())
      .addUint256(minTokenAmount.toString())
      .addUint256(minHbarAmount.toString())
      .addAddress(client.operatorAccountId.toSolidityAddress())
      .addUint256(currentTimestamp + 1800); // Deadline: +30 minutos

    // Declaración de variables para almacenar resultados comunes
    let txReceipt, amountToken, amountHBAR, liquidity;

    if (poolExists) {
      // 1. Asociar el token LP a la cuenta del operador
      const lpTokenId = TokenId.fromSolidityAddress(poolAddress);

      // Verificar si la cuenta está asociada al token LP
      const accountInfo = await new AccountInfoQuery()
        .setAccountId(client.operatorAccountId)
        .execute(client);

      const tokenRelationships = Array.from(
        accountInfo.tokenRelationships.values()
      );
      const isAssociated = tokenRelationships.some(
        (tr) => tr.tokenId.toString() === lpTokenId.toString()
      );

      if (!isAssociated) {
        const accountUpdateTx = new AccountUpdateTransaction()
          .setAccountId(client.operatorAccountId)
          .setMaxAutomaticTokenAssociations(
            accountInfo.maxAutomaticTokenAssociations + 1
          );

        await (await accountUpdateTx.execute(client)).getReceipt(client);

        const associateTx = await new TokenAssociateTransaction()
          .setAccountId(client.operatorAccountId)
          .setTokenIds([lpTokenId])
          .freezeWith(client)
          .sign(operatorKey);

        await (await associateTx.execute(client)).getReceipt(client);
      }

      // 2. Asegurar firma explícita en la transacción
      const liquidityTx = await new ContractExecuteTransaction()
        .setPayableAmount(Hbar.fromTinybars(hbarTinybars))
        .setContractId(ContractId.fromString(SAUCERSWAP_V1_ROUTER))
        .setGas(5_000_000)
        .setFunction("addLiquidityETH", liquidityParams)
        .freezeWith(client) // Congela la transacción
        .sign(operatorKey); // Firma explícita

      txReceipt = await liquidityTx.execute(client);
      const record = await liquidityTx.getRecord(client);
      const result = record.contractFunctionResult;
      [amountToken, amountHBAR, liquidity] = [
        result.getUint256(0),
        result.getUint256(1),
        result.getUint256(2),
      ];
    } else {
      // Si no existe: calcular fee de creación del pool y llamar a la función addLiquidityETHNewPool
      const feeQuery = await new ContractCallQuery()
        .setContractId(ContractId.fromString(SAUCERSWAP_V1_FACTORY))
        .setGas(5_000_000)
        .setFunction("pairCreateFee")
        .execute(client);

      const whbarHelperContract = "0.0.5286055"; // Testnet WhbarHelper
      const convertFeeTx = new ContractCallQuery()
        .setContractId(ContractId.fromString(whbarHelperContract))
        .setGas(5_000_000)
        .setFunction(
          "tinycentsToTinybars",
          new ContractFunctionParameters().addUint256(feeQuery.getUint256(0))
        );

      const convertedFee = await convertFeeTx.execute(client);
      const feeTinybars = convertedFee.getUint256(0);

      // Sumar el fee al monto de hbar para enviar en la transacción
      const totalPayable = hbarTinybars.add(
        Long.fromString(feeTinybars.toString())
      );

      const liquidityTx = await new ContractExecuteTransaction()
        .setContractId(ContractId.fromString(SAUCERSWAP_V1_ROUTER))
        .setGas(5_000_000)
        .setFunction("addLiquidityETHNewPool", liquidityParams)
        .setPayableAmount(Hbar.fromTinybars(totalPayable)) // Fee + HBAR liquidity
        .freezeWith(client)
        .sign(operatorKey);

      txReceipt = await (await liquidityTx.execute(client)).getReceipt(client);
      const record = await liquidityTx.getRecord(client);
      const result = record.contractFunctionResult;
      [amountToken, amountHBAR, liquidity] = [
        result.getUint256(0),
        result.getUint256(1),
        result.getUint256(2),
      ];
    }

    // Consulta final: obtener la dirección del pool de liquidez
    const finalPoolQuery = new ContractCallQuery()
      .setContractId(ContractId.fromString(SAUCERSWAP_V1_FACTORY))
      .setGas(5_000_000)
      .setFunction(
        "getPair",
        new ContractFunctionParameters()
          .addAddress(tokenId.toSolidityAddress())
          .addAddress(WHBAR_SOLIDITY_ADDRESS) // Usar WHBAR aquí
      );
    const finalPoolResponse = await finalPoolQuery.execute(client);
    poolAddress = finalPoolResponse.getAddress(0);

    // Actualizar la base de datos (asegúrate de que Supabase esté correctamente configurado)
    await supabase
      .from("parties")
      .update({
        pool_id: poolAddress,
        pool_url: `https://app.saucerswap.finance/pool/${poolAddress}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", event_id);

    res.status(200).json({
      success: true,
      message: `Liquidez ${poolExists ? "añadida" : "creada"} exitosamente`,
      data: {
        pool_address: poolAddress,
        token_used: `${amountToken.div(10 ** tokenDecimals)} ${
          tokenInfo.symbol
        }`,
        hbar_used: Hbar.fromTinybars(amountHBAR).toString(),
        liquidity_tokens: liquidity.toString(),
        transaction_id: txReceipt ? txReceipt.transactionId.toString() : null,
      },
    });
  } catch (error) {
    console.error("Error in createLiquidityPool:", error);
    next(new Error(`Failed to handle liquidity: ${error.message}`));
  } finally {
    if (client) await client.close();
  }
};

export const getTokenMetadata = async (req, res, next) => {
  try {
    const { event_id } = req.query;

    const { data, error } = await supabase
      .from("parties")
      .select("*")
      .eq("id", event_id)
      .single();
    if (!data || error) throw new Error("Evento no encontrado");

    fetch(
      `https://white-kind-toad-673.mypinata.cloud/ipfs/${data.token_metadata}`
    )
      .then((response) => response.json())
      .then((data) => {
        res.json({ success: true, metadata: data });
      });
  } catch (e) {
    console.error("Error en getTokenMetadata:", e);
    next(new Error(`Error al obtener metadatos del token: ${e.message}`));
  }
};

export const windrawMoney = async (req, res, next) => {
  try {
    const { event_id, user_wallet, amount } = req.body;

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
    const memo = `windraw hbar from sonnar app -> https://sonnar.club -> ${new Date().toISOString()}`;

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

    res.json({
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

export const windrawToken = async (req, res, next) => {
  try {
    const { event_id, user_wallet, amount } = req.body;

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
    const memo = `windraw token from sonnar app -> https://sonnar.club -> ${new Date().toISOString()}`;

    // Configurar cliente
    const operatorKey = PrivateKey.fromString(
      decryptKey(data.parti_wallet_private_key)
    );

    const client = getHederaClient().setOperator(
      data.parti_wallet,
      operatorKey
    );

    const transaction = await new TransferTransaction()
      .addTokenTransfer(
        TokenId.fromString(data.token_id),
        AccountId.fromString(data.parti_wallet),
        Number(-amount * 100)
      )
      .addTokenTransfer(
        TokenId.fromString(data.token_id),
        AccountId.fromString(user_wallet),
        Number(amount * 100)
      )
      .setTransactionMemo(memo)
      .freezeWith(client);

    const transferResponse = await transaction.execute(client);
    const transferReceipt = await transferResponse.getReceipt(client);

    console.log(`Retito completado:`, transferReceipt.status.toString());

    res.json({
      success: true,
      transactionId: transferResponse.transactionId.toString(),
      tokensReceived: amount,
    });
  } catch (e) {
    console.error("Error en windrawToken: ", e);
    next(
      new Error(`Error retirar un token de la wallet del parti: ${e.message}`)
    );
  }
};
