# R8/ProGuard 规则。
# 当前 minifyEnabled = false，本文件中的规则不会生效；
# 它们的作用是「日后一旦开启混淆/优化」时，保证 WebView 注入桥不被改名或移除。
# 否则 JS 侧按名字调用 window.DyBridge.xxx 会直接失效（方法被改名 → 调用报错/无响应），
# 且这类故障只在 release 包上出现，debug 包无法复现，排查成本很高。

# 1) 保留 @JavascriptInterface 注解本身，避免注解被剥离后规则 2 匹配不到任何方法。
-keep @interface android.webkit.JavascriptInterface

# 2) 保留所有被 @JavascriptInterface 标注的方法（注解是 WebView 反射调用的入口，不能被混淆）。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 3) 保留注入桥实现类及其全部成员：JS 侧通过 addJavascriptInterface 注册的固定名字访问，
#    类名/方法名一旦被改写，桥就断了（AGP 默认规则不覆盖自定义内部类的成员）。
-keep class com.lmt.dyindex.MainActivity$DyBridge { *; }
