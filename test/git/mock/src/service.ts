import { User } from './model';
export class UserService {
  findById(id: string): User | null { return null; }
  findAll(): User[] { return []; }
}

export class OrderService {
  findByUser(userId: string): import('./model').Order[] { return []; }
}
