import { FastifyInstance } from 'fastify';
import { authGuard } from '../../core/middleware/auth.middleware.js';
import { idParamSchema } from '../../core/validation/params.js';
import { TasksService } from './tasks.service.js';
import { createTaskSchema, updateTaskSchema, taskQuerySchema } from './tasks.schema.js';

const service = new TasksService();

export async function taskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);

  app.get('/', async (request, reply) => {
    const filters = taskQuerySchema.parse(request.query);
    const tasks = await service.listTasks(request.userId, filters);
    return reply.send(tasks);
  });

  app.post('/', async (request, reply) => {
    const body = createTaskSchema.parse(request.body);
    const task = await service.createTask(request.userId, body);
    return reply.status(201).send(task);
  });

  app.get('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const task = await service.getTask(id, request.userId);
    return reply.send(task);
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = updateTaskSchema.parse(request.body);
    const task = await service.updateTask(id, request.userId, body);
    return reply.send(task);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    await service.deleteTask(id, request.userId);
    return reply.status(204).send();
  });

  app.post('/:id/toggle', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const task = await service.toggleTask(id, request.userId);
    return reply.send(task);
  });

  app.get('/stats', async (request, reply) => {
    const stats = await service.getStats(request.userId);
    return reply.send(stats);
  });
}
