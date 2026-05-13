import { useBreakpoint } from '../../shared/hooks/useBreakpoint';
import { MobileLayout } from './MobileLayout';
import { DesktopLayout } from './DesktopLayout';

export function AppShell() {
  const bp = useBreakpoint();
  return bp === 'mobile' ? <MobileLayout /> : <DesktopLayout />;
}
