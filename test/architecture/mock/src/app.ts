import { AuthService } from './auth/service';
import { UserRepository } from './user/repository';
export class App { auth = new AuthService(); users = new UserRepository(); }
