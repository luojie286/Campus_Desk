package com.campusdesk.tsnetprobe;

import android.app.Activity;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.net.NetworkInterface;
import java.util.Collections;
import com.campusdesk.tsnet.probe.Client;
import com.campusdesk.tsnet.probe.Probe;

/** Isolated feasibility test: no VpnService, no writes to the business API. */
public class ProbeActivity extends Activity {
    private Client client;
    private TextView status;
    private String loginUrl = "";
    private boolean busy = false;
    private boolean autoReadTriggered = false;
    private int readAttempts = 0;
    private final JSONObject evidence = new JSONObject();

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32,48,32,32);
        status = new TextView(this);
        status.setText("内嵌 Tailscale 技术验证\n请保持 365VPN 连接。此程序不会申请系统 VPN 权限。");
        layout.addView(status);
        button(layout,"启动私网测试",this::start);
        button(layout,"打开本次节点授权页面",()->{
            if (!loginUrl.isEmpty()) startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(loginUrl)));
            else status.setText("授权网址尚未生成，请先启动测试并等待 login_required 阶段。");
        });
        button(layout,"只读测试后台",this::read);
        setContentView(layout);
        try {
            evidence.put("androidApi",android.os.Build.VERSION.SDK_INT);
            evidence.put("vpnBefore",vpnSnapshot());
            evidence.put("usesVpnService",false);
            saveEvidence();
        } catch (Exception ignored) { status.setText("初始化验证记录失败"); }
        if (getIntent().getBooleanExtra("start",false)) start();
    }
    private void button(LinearLayout view,String text,Runnable action) {
        Button button = new Button(this); button.setText(text);
        button.setOnClickListener(v->action.run());view.addView(button);
    }
    private JSONArray vpnSnapshot() throws Exception {
        ConnectivityManager cm = (ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
        JSONArray result = new JSONArray();
        for (Network network:cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) result.put(network.getNetworkHandle());
        }
        return result;
    }
    private String interfaces() {
        JSONArray rows = new JSONArray();
        try {
            for (NetworkInterface nic:Collections.list(NetworkInterface.getNetworkInterfaces())) {
                JSONObject row = new JSONObject();
                row.put("Name",nic.getName());row.put("Index",nic.getIndex());row.put("MTU",nic.getMTU());
                int flags = nic.isUp()?33:0;
                if (nic.isLoopback()) flags |= 4;
                if (nic.isPointToPoint()) flags |= 8;
                if (nic.supportsMulticast()) flags |= 16;
                row.put("Flags",flags);
                JSONArray addresses = new JSONArray();
                nic.getInterfaceAddresses().forEach(address->{
                    String ip = address.getAddress().getHostAddress().split("%",2)[0];
                    addresses.put(ip+"/"+address.getNetworkPrefixLength());
                });
                row.put("Addresses",addresses);rows.put(row);
            }
        } catch (Exception ignored) { return "invalid"; }
        return rows.toString();
    }
    private void start() {
        if (busy) return;
        busy = true;
        new Thread(()->{
            try {
                File state = new File(getFilesDir(),"tsnet-state");state.mkdirs();
                client = Probe.newClient(state.getAbsolutePath(),this::interfaces,event->runOnUiThread(()->event(event)));
                client.start();
            } catch (Throwable error) {
                runOnUiThread(()->{
                    // Never log Go exception messages, which may contain peer metadata.
                    event("{\"stage\":\"native_start_exception\"}");
                    busy = false;
                });
            }
        },"tsnet-probe-start").start();
    }
    private void event(String raw) {
        try {
            JSONObject value = new JSONObject(raw);
            String stage = value.getString("stage");
            evidence.put("stage",stage);evidence.put("vpnAfter",vpnSnapshot());
            evidence.put("sameVpn",evidence.getJSONArray("vpnBefore").toString().equals(evidence.getJSONArray("vpnAfter").toString()));
            if (value.has("status")) evidence.put("httpStatus",value.getInt("status"));
            if (value.has("validJson")) evidence.put("validJson",value.getBoolean("validJson"));
            if (value.has("url")) {
                Uri uri = Uri.parse(value.getString("url"));
                if ("https".equals(uri.getScheme()) && "login.tailscale.com".equals(uri.getHost())) loginUrl = uri.toString();
            }
            String detail = "阶段："+stage+"\n原 VPN 网络保持："+evidence.getBoolean("sameVpn");
            if (stage.equals("login_required")) detail += "\n请点击授权按钮，为测试程序自己的节点授权。";
            if (stage.equals("online")) detail += "\n私网已连接，可以点击只读测试后台。";
            if (stage.equals("read_complete")) {
                int code = value.getInt("status");
                detail += "\nHTTP "+code;
                detail += code == 200 && value.optBoolean("validJson") ? "：已成功读取真实后台。" : "：读取未通过，请让电脑检查记录。";
            }
            if (stage.equals("read_failed")) detail += "\n连接失败，尚未读取后台。";
            status.setText(detail);
            saveEvidence();
            if (getIntent().getBooleanExtra("read",false) && stage.equals("read_failed") && !getIntent().getBooleanExtra("retried",false)) {
                getIntent().putExtra("retried",true);
                // One delayed retry of this GET only; never used for mutations.
                status.postDelayed(this::read,5000);
            }
            if (stage.equals("online") && getIntent().getBooleanExtra("read",false) && !autoReadTriggered) {
                autoReadTriggered = true;
                read();
            }
        } catch (Exception ignored) { status.setText("测试结果解析失败"); }
    }
    private void read() {
        if (client == null) return;
        try {
            String raw = new String(Files.readAllBytes(new File(getFilesDir(),"probe-config.json").toPath()),StandardCharsets.UTF_8);
            JSONObject config = new JSONObject(raw);
            evidence.put("readAttempts",++readAttempts);
            status.setText("正在通过内嵌 Tailscale 读取后台，请稍候……");
            client.read(config.getString("base"),config.getString("token"));
        } catch (Exception ignored) { status.setText("主机尚未提供本次只读连接配置"); }
    }
    private void saveEvidence() throws Exception {
        Files.write(new File(getFilesDir(),"probe-evidence.json").toPath(),evidence.toString(2).getBytes(StandardCharsets.UTF_8));
    }
    @Override protected void onDestroy() {
        if (client != null) new Thread(()->client.close(),"tsnet-probe-close").start();
        super.onDestroy();
    }
}
