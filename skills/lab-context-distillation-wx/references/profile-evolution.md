# 增量、纠正、撤回与回滚

`profile_history.py` 把个人上下文的变化实现为追加式状态机。每次操作都产生新的
只读 JSON snapshot、profile hash、snapshot hash 和哈希链事件；旧版本不改写。

正式操作：

- `profile-update`：追加新的 source、event、evidence、asset；重复 ID 拒绝；
- `profile-correct`：在新版本替换一个指定 ID，身份不能变化；
- `profile-withdraw`：把来源标记为 withdrawn，并停用依赖它的事件、证据和资产，
  但不从历史版本删除；
- `profile-reextract`：只替换一个领域，记录被替代事件 ID，其他领域保持不变；
- `profile-rollback`：把目标旧版本复制成一个新的当前版本，不移动历史指针。

所有操作必须以当前最新版本为 base，避免并行分叉静默覆盖。`verify()` 检查版本
连续性、文件只读属性、snapshot 链、事件链和二者的绑定。

来源撤回、纠正和领域重提取会改变后续运行时结果，因此必须重建 portable
package 和 QA；它们不允许触发 accepted Map 重跑。新增资料只处理新 generation
及受影响领域。
