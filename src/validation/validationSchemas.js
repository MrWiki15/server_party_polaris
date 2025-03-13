import Joi from "joi";

export const eventSchema = Joi.object({
  event_id: Joi.string().required(),
});

export const donationSchema = Joi.object({
  event_id: Joi.string().required(),
  donor_wallet: Joi.string()
    .pattern(/^0\.0\.\d+$/)
    .required(),
  amount_hbar: Joi.number().min(1).max(1000).required(),
});
