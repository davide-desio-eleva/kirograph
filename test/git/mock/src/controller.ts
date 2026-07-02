import { UserService } from './service';
export class UserController {
  private svc = new UserService();
  getUser(id: string) { return this.svc.findById(id); }
  listUsers() { return this.svc.findAll(); }
}
