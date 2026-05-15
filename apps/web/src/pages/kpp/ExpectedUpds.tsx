import type { SourceDocument } from '@matcheck/contracts';
import { ExpectedSourceDocsList } from '../shared/ExpectedSourceDocsList';

export function ExpectedUpds({ onOpen }: { onOpen: (upd: SourceDocument) => void }) {
  return <ExpectedSourceDocsList direction="inbound" onOpen={onOpen} />;
}
