// Payment module — mock source for KiroGraph wiki test project

export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
}

export class PaymentService {
  async createIntent(amount: number, currency = 'eur'): Promise<PaymentIntent> {
    return {
      id: `pi_${Date.now()}`,
      amount,
      currency,
      status: 'pending',
    };
  }

  async confirm(intentId: string): Promise<PaymentIntent> {
    return { id: intentId, amount: 0, currency: 'eur', status: 'succeeded' };
  }

  async refund(intentId: string): Promise<void> {
    // Refunds are processed asynchronously via the refund queue
    console.log(`Refund queued for ${intentId}`);
  }
}
