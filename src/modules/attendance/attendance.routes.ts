import { FastifyInstance } from 'fastify';
import { authGuard } from '../../core/middleware/auth.middleware.js';
import { idParamSchema, sessionParamsSchema } from '../../core/validation/params.js';
import { AttendanceService } from './attendance.service.js';
import { createSubjectSchema, updateSubjectSchema, logSessionSchema } from './attendance.schema.js';

const service = new AttendanceService();

export async function attendanceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);

  app.get('/', async (request, reply) => {
    const subjects = await service.listSubjects(request.userId);
    return reply.send(subjects);
  });

  app.post('/', async (request, reply) => {
    const body = createSubjectSchema.parse(request.body);
    const subject = await service.createSubject(request.userId, body);
    return reply.status(201).send(subject);
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = updateSubjectSchema.parse(request.body);
    const subject = await service.updateSubject(id, request.userId, body);
    return reply.send(subject);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    await service.deleteSubject(id, request.userId);
    return reply.status(204).send();
  });

  app.get('/:id/sessions', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const sessions = await service.getSessions(id, request.userId);
    return reply.send(sessions);
  });

  app.post('/:id/sessions', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = logSessionSchema.parse(request.body);
    const session = await service.logSession(id, request.userId, body);
    return reply.status(201).send(session);
  });

  app.delete('/:id/sessions/:sessionId', async (request, reply) => {
    const { id, sessionId } = sessionParamsSchema.parse(request.params);
    await service.deleteSession(id, sessionId, request.userId);
    return reply.status(204).send();
  });
}
