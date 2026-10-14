export default async function (f: any) {
  f.get('/', async () => 'ok');
}
