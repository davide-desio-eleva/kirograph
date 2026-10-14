import Fastify from 'fastify';
import { api as apiPlugin } from './api';
import * as v1 from './v1';
import health from './health';

const app: any = Fastify();

// named import under an alias; the plugin registers another plugin (nesting)
app.register(apiPlugin, { prefix: '/api' });
// namespace member
app.register(v1.routes, { prefix: '/v1' });
// default export, declared anonymously
app.register(health, { prefix: '/health' });
// require() target
app.register(require('./legacy'), { prefix: '/legacy' });
// inline plugin
app.register(async (f: any) => {
  f.get('/inline', async () => 'ok');
}, { prefix: '/inline' });

app.get('/root', async () => 'root');

export default app;
