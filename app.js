import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import eventsRoutes from "./src/routes/eventsRoutes.js";
import donationsRoutes from "./src/routes/donationsRoutes.js";
import { validateEncryptionKey } from "./src/utils/crypto.js";
import webPush from "web-push";

dotenv.config();

webPush.setVapidDetails(
  "universe@polarisweb3.org", // Email de contacto
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, // Clave pública VAPID
  process.env.VAPID_PRIVATE_KEY // Clave privada VAPID
);

// Validar clave de encriptación al iniciar
validateEncryptionKey();

const app = express();

// Configuración de middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "10kb" }));

// Rutas
app.use("/events", eventsRoutes);
app.use("/donations", donationsRoutes);
app.post("/worker", async (req, res) => await handler(req, res));

// Manejo de errores centralizado
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
  res.status(err.statusCode || 500).json({
    status: "error",
    message: err.message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

async function handler(req, res) {
  const { subscription, title, body } = req.body;

  try {
    await webPush.sendNotification(
      subscription,
      JSON.stringify({ title, body })
    );
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error enviando notificación:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(
    `🔒 Modo seguro: ${
      process.env.NODE_ENV === "production" ? "Activado" : "Desarrollo"
    }`
  );
});
