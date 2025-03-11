import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import eventsRoutes from "./src/routes/eventsRoutes.js";
import donationsRoutes from "./src/routes/donationsRoutes.js";
import { validateEncryptionKey } from "./src/utils/crypto.js";

dotenv.config();

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
app.use("/api/v1/events", eventsRoutes);
app.use("/api/v1/donations", donationsRoutes);

// Manejo de errores centralizado
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
  res.status(err.statusCode || 500).json({
    status: "error",
    message: err.message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(
    `🔒 Modo seguro: ${
      process.env.NODE_ENV === "production" ? "Activado" : "Desarrollo"
    }`
  );
});
