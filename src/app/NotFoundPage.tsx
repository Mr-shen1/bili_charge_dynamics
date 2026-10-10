import { useAppNavigation } from './Navigation';
import styles from '../dynamics/Dynamics.module.css';

export function NotFoundPage() {
  const { returnToList } = useAppNavigation();
  return <main className={styles.page}>
    <h1>未找到页面</h1>
    <p>这个地址没有对应页面，可以返回动态列表继续浏览。</p>
    <button className={styles.button} type="button" onClick={returnToList}>返回列表</button>
  </main>;
}
