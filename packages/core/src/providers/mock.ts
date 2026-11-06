import { ProviderError, type ModelRequest, type ModelResponse, type Provider } from './types.js';

export type MockStep =
  | ModelResponse
  | ProviderError
  | ((req: ModelRequest) => ModelResponse | ProviderError | Promise<ModelResponse | ProviderError>);

/**
 * Scripted provider for tests and offline demos. Each call consumes the next step.
 * When the script is exhausted it answers "done".
 */
export class MockProvider implements Provider {
  readonly id: string;
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly script: MockStep[] = [],
    id = 'mock',
  ) {
    this.id = id;
  }

  push(...steps: MockStep[]): void {
    this.script.push(...steps);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone({ ...req, signal: undefined, onDelta: undefined }));
    let step = this.script.shift() ?? { text: 'done', toolCalls: [] };
    if (typeof step === 'function') step = await step(req);
    if (step instanceof ProviderError) throw step;
    if (step.text) req.onDelta?.({ text: step.text });
    return step;
  }
}
