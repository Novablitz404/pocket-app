export const colors = {
  bg: '#FBF3EC',
  card: '#FFFFFF',
  ink: '#0F1B14',
  sub: '#68756D',
  accent: '#00A862',
  accentDark: '#007A48',
  accentSoft: '#E2F4EA',
  gold: '#B8860B',
  goldSoft: '#F7E9C6',
  danger: '#D64545',
  border: '#F0E3D7',
};

export const radius = { sm: 10, md: 16, lg: 24, full: 999 };

export function formatUsd(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}
