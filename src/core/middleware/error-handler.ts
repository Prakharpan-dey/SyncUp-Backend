import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-errors.js';
import { ZodError } from 'zod';

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // Known application errors
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      message: error.message,
      code: error.code,
    });
  }

  // Zod validation errors
  if (error instanceof ZodError) {
    return reply.status(422).send({
      message: 'Validation error',
      code: 'VALIDATION_ERROR',
      errors: error.flatten().fieldErrors,
    });
  }

  // Fastify built-in validation errors
  if (error.validation) {
    return reply.status(422).send({
      message: 'Validation error',
      code: 'VALIDATION_ERROR',
      errors: error.validation,
    });
  }

  // Rate limit exceeded
  if (error.statusCode === 429) {
    return reply.status(429).send({
      message: 'Too many requests, please try again later',
      code: 'RATE_LIMIT_EXCEEDED',
    });
  }

  // Fastify's own client errors — malformed JSON, empty body with a JSON
  // content-type, unsupported media type, payload too large, and so on.
  //
  // These already carry the right status and a message describing what the
  // caller got wrong, so pass both through. Without this they fell into the
  // catch-all below and every one of them surfaced as a 500, which made a
  // client mistake look like a server outage.
  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    return reply.status(error.statusCode).send({
      message: error.message,
      code: error.code ?? 'BAD_REQUEST',
    });
  }

  // Unknown errors — log full error, return generic message
  request.log.error(error);
  return reply.status(500).send({
    message: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}
