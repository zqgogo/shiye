import { mountWorkspace } from '@shiye/workspace';

const element = document.getElementById('root');
if (!element) {
  throw new Error('缺少工作台根节点');
}
void mountWorkspace(element);
