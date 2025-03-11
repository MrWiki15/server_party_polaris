import express from "express";
import {
  createEvent,
  checkWalletFunding,
  createTokenForEvent,
} from "../controllers/eventController.js";
import { eventSchema } from "../validation/validationSchemas.js";
import { validate } from "../middleware/validationMiddleware.js";

const router = express.Router();

router.post("/", validate(eventSchema), createEvent);
router.post("/check-funding", checkWalletFunding);
router.post("/create-token", createTokenForEvent);

export default router;
