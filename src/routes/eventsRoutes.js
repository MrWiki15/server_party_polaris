import express from "express";
import {
  createEvent,
  checkWalletFunding,
  createTokenForEvent,
} from "../controllers/eventController.js";
import { eventSchema } from "../validation/validationSchemas.js";
import { validate } from "../middleware/validationMiddleware.js";

const router = express.Router();

router.post("/create", validate(eventSchema), createEvent);
router.post("/check_wallet_founding", checkWalletFunding);
router.post("/create_token", createTokenForEvent);

export default router;
