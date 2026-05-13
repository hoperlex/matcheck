export type EdoIncomingDocument = {
  providerMessageId: string;
  receivedAt: Date;
  xml: string;
};

export interface EdoAdapter {
  listIncoming(since?: Date): Promise<EdoIncomingDocument[]>;
  markProcessed(providerMessageId: string): Promise<void>;
}

export type EdoCredentials = {
  apiClientId: string;
  login: string;
  password: string;
  boxId: string;
};
