// SPDX-License-Identifier: AGPL-3.0-only
import { createRoot } from 'react-dom/client';
import { ColumnChart } from '../../packages/ui/src/kit/chart-column.tsx';
import '../../packages/ui/src/styles/2-primitives.css';

const root = document.getElementById('root');
if (root === null) throw new Error('proof fixture needs its root');
createRoot(root).render(
  <ColumnChart
    name="Net sales"
    labels={['Mon', 'Tue']}
    bars={[{ label: 'Refunds', values: [-30, -20], unit: 'money' }]}
  />,
);
