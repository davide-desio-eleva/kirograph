import { usersRoutes } from './users';

export async function api(f: any) {
  // nested plugin with no prefix of its own beyond '/users'
  f.register(usersRoutes, { prefix: '/users' });
  f.get('/status', async () => 'up');
}
