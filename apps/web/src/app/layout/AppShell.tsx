import { useBreakpoint } from '../../shared/hooks/useBreakpoint';
import { MobileLayout } from './MobileLayout';
import { TabletLayout } from './TabletLayout';
import { DesktopLayout } from './DesktopLayout';

export function AppShell() {
  const bp = useBreakpoint();
  if (bp === 'mobile') return <MobileLayout />;
  if (bp === 'tablet') return <TabletLayout />;
  return <DesktopLayout />;
}
