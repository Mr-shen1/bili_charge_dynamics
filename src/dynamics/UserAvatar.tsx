import { useState } from 'react';
import type { User } from '../data/contracts';

export function UserAvatar({ user, className, decorative = false }: {
  user: User; className?: string; decorative?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const source = user.avatarUrl && user.avatarUrl !== failedUrl ? user.avatarUrl : '/default-avatar.svg';
  return <img className={className} src={source} alt={decorative ? '' : `${user.nickname ?? '未知用户'}的头像`}
    width="44" height="44" onError={() => setFailedUrl(source)} />;
}
