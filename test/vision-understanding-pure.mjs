/**
 * 纯层 understanding 测试聚合入口。
 *
 * 仓库没有单独的 `vision-understanding-pure.mjs`：纯计算/运行时/包装形状测试分别放在
 * `vision-understanding-runtime.mjs` 与 `vision-understanding-analyzer-shape.mjs`。这个入口只
 * 导入它们，便于按统一命令执行，不重复实现断言。
 *
 * Run: node test/vision-understanding-pure.mjs
 */
import './vision-understanding-runtime.mjs';
import './vision-understanding-analyzer-shape.mjs';
