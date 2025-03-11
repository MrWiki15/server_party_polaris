import Joi from "joi";

export const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body, {
    abortEarly: false,
    allowUnknown: false,
  });

  if (error) {
    const errors = error.details.map((err) => ({
      field: err.path.join("."),
      message: err.message.replace(/"/g, ""),
    }));

    return res.status(400).json({
      status: "error",
      message: "Validation failed",
      errors,
    });
  }

  next();
};
