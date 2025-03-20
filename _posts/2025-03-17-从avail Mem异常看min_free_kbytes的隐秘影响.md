---
layout: post
title: '从avail Mem异常看min_free_kbytes的隐秘影响'
date: 2025-03-17
author: 陆福迪
cover: '/picture/1.avif'
cover_author: 'Lerone Pieters'
cover_author_link: 'https://unsplash.com/@leronep'
categories: Linux
tags: 
- Linux
- 生产问题

---
##  創造力的祕密，就在於懂得如何隱藏你的來源。

### 背景

昨天，接到运维电话，接口服务所在的几台服务器都出现了告警，可用内存已降至10%以下。印象里该服务器规格是4C16G，上面只部署了接口服务和zabbix监控；
接口服务主要功能是监听mq消息，将变更的产品数据信息写入数据库，为其设置的最大堆内存是12G，其数据压力并不大。


### 检查服务器的内存使用情况
首先是经典的 <span style="background:#fbd4d0;">**top free df** </span>的 三连

```
MiB Mem: 14986.6 total    1223.2 free   10791.9 used   2971.4 buff/cache 1256.4 avail Mem

PID      USER   PR  NI   VIRT        RES         SHR         S     %CPU      %MEM         

1395    oper    20   0   18.7g      9.8g        19200      s        1.0       66.8    
```



 通过top命令可以看到服务占用总内存不到10G，是一个比较合理的范畴。

但是，有另外两个问题：

1. 服务器总内存是16G，但是total 列显示只有15G，有1G的内存丢失了

2. 正常情况下（也不是完全精确，有时候available 会少几百M，也是正常的）available memory ≈ free + buff/cache 。但是该服务器上， avail Mem比 free + buff/cache 之和少了接近3个G

   

### 排查总内存丢失问题

首先排查操作系统预留内存的情况，**查看内核保留内存**。检查`dmesg`日志中内存初始化信息：

```
$ dmesg | grep -i memory
##响应中出现了以下内容
kexec_core: Reserving 256MB of low memory at 3840MB for crashkernel (System low RAM: 3072M)
```

`crashkernel`参数的作用

> `crashkernel` 是一个在 Linux 内核启动时使用的参数，它主要用于预留一部分物理内存，以便在系统发生内核崩溃（Kernel Crash）时能将相关信息保存下来，帮助后续分析崩溃原因。`crashkernel` 的内存需求与内核崩溃时需转储的数据量相关，通常 **128M~256M 足够**。



检查该参数设置的实际大小：

```
$ cat /proc/cmdline | grep crashkernel
```

其设置的值为<font color=red>1024M </font><font color=Yellow> </font>，与总内存丢失1G是吻合的。且16G内存的服务器配置crashkernel参数为256M才是合理的，所以需要修改该参数。

```bash
vim /etc/default/grub
### 修改 GRUB_CMDLINE_LINUX 行（16G内存设置其为auto，会默认分配256M内存）：
GRUB_CMDLINE_LINUX="... crashkernel=auto"
### 更新grub：
grub2-mkconfig -o /boot/grub2/grub.cfg
### 重启服务器
### 重启接口服务
```



再次使用top命令查看内存，总内存恢复正常，但可用内存依然不正确，有1.5G的内存凭空消失了

```
MiB Mem: 16266.6 total    6084.2 free   9310.9 used   872 buff/cache 5337.6 avail Mem

PID      USER   PR  NI   VIRT        RES         SHR         S     %CPU      %MEM         

1425    oper    20   0   18.7g      8.5g        21504      s        1.0       53.5    
```





### 排查可用内存异常
1111111

#### 分析与释放buff-cache内存


首先查找的方向，是**不可回收的buff/cache内存过大**，导致可用内存变小。

```
## 内存使用情况，可以看到avail Mem与free接近一致
MiB Mem: 16286.6 total    2523.2 free   10791.9 used   2971.4 buff/cache 2556.4 avail Mem
```

在服务器上安装了[HCache](https://github.com/silenceshell/hcache)工具，使用hcache -pid <javapId> 检查 接口服务占用的`缓存内存`，但执行后，发现占用空间很小，只有400M左右。



然后执行缓存内存清除操作：

```bash
##清除缓存内存
$ echo 3 > /proc/sys/vm/drop_caches

## 进行缓存回收后的内存现场
MiB Mem: 16286.6 total    5153.4 free   10583.2 used   557.6 buff/cache 2827.4 avail Mem
```

buff/cache内存显著减小了，这部分内存绝大部分也增加到了free列上，但avail列增长的有限，只增长了300M。因此，可以排除是buff/cache内存问题。

目前只能看到avail远小于free，这是相当不正常的，肯定还遗漏了重要的计算参数，所以继续将思路延伸，查找available内存详细的计算方式。

#### available内存计算方式

```
void si_meminfo(struct sysinfo *val) {
    // ...
    val->mem_avail = si_mem_available(); // 计算可用内存
}

unsigned long si_mem_available(void) {
    unsigned long available;
    unsigned long pagecache;
    unsigned long wmark_low = 0;
    
    // 获取空闲内存和页面缓存
    available = global_page_state(NR_FREE_PAGES) + global_node_page_state(NR_FILE_PAGES);
    
    // 减去保留的 low watermark 内存
    wmark_low = totalreserve_pages; 
    available -= wmark_low;
    
    // 加上可回收的 Slab 内存
    available += global_node_page_state(NR_SLAB_RECLAIMABLE);
    
    return available;
}


#####可用内存的计算方式：
MemAvailable≈MemFree+可回收缓存（Active(file)+Inactive(file)+SReclaimable−low_watermark
```

其中的`空闲内存（Active(file)）`、`页面缓存Inactive(file)`和 `Slab 内存（SReclaimable）`可以在`/proc/meminfo`中看到，都是比较正常的值。唯一剩余的属性就是：`watermark`



#### 计算low_watermark

> Linux 内核中的 **内存水位线（Memory Watermarks）** 决定了何时触发内存回收机制（如 **kswapd** 后台回收或直接回收）。其核心参数是 **`vm.min_free_kbytes`**，该参数直接控制 **最低保留空闲内存（min_free_kbytes）**，并间接决定了其他水位线（`low` 和 `high`），**这部分内存属于系统预留内存，不会计算在可用内存内**

```
###查看min_free_kbytes参数配置
$ cat /proc/sys/vm/min_free_kbytes
763264
```

服务器配置的`min_free_kbytes`值是763264，`low_watermark`=` min_free_kbytes` * 1.5，粗略计算下预留内存在1G左右。但前面说过，对`buff/cache`执行回收后，`free`与`avail`差值在2.3G，难道**还有其他的预留内存**？

由于天色已晚，决定今天先释放部分预留内存，剩余的问题明天再搞



#### 设置预留内存

预留内存的作用：

> 避免性能下降：
>
> 通过合理设置内存水位，可以避免因内存不足而导致的性能下降。
> 例如，在内存紧张时，提前唤醒 kswapd 进行内存回收，可以减少直接内存回收(direct reclaim)的频率，从而降低进程的内存分配延迟。
>
> 提高系统稳定性：
>
> 内存水位机制确保系统在内存不足时能够及时采取措施，避免OOM错误的发生。通过调整水位值，可以平衡内存使用和系统性能，提高系统的整体稳定性。

看了一下min_free_kbytes的值的配置，大部分都建议配置在总内存的1%-2%左右，也既是160M-320M,再考虑到服务器上只部署了接口服务和监控服务，且有比较完善的监控告警，所以该值可以适当的调小。遂决定将其更改为200M。

```
###修改预留内存
$ sysctl -w vm.min_free_kbytes=204800
```



没想到的事情发生了，修改了`min_free_kbytes`参数后，再查看内存信息，展示如下

```
## 内存使用情况，可以看到avail Mem明显增大
MiB Mem: 16286.6 total    5166.2 free   10583.2 used   553.1 buff/cache 4733.1 avail Mem
```

可以明显看到，与前一次的内存信息对比，avail Mem增加了1.9G。至此，可用内存就恢复到了一个比较正常的区间。

至于为什么修改`min_free_kbytes`减少的内存与 `avail Mem`增加的内存，差距如此之大，截止目前，还未找到比较权威的文章去解释。若后续找到答案，会在文章最后进行补全

### 参考资料：

[hcache的打包与使用](https://blog.csdn.net/qq_39233798/article/details/122322433)

[Available Mem的计算方式](https://lotabout.me/2021/Linux-Available-Memory/)

[min_free_kbytes值的估算](https://www.cnblogs.com/zphj1987/p/13639801.html)



