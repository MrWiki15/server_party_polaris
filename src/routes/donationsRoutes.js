import express from "express";
import { donateToEvent } from "../controllers/donationController.js";
import { donationSchema } from "../validation/validationSchemas.js";
import { validate } from "../middleware/validationMiddleware.js";

const router = express.Router();

router.post("/", validate(donationSchema), donateToEvent);

export default router;
