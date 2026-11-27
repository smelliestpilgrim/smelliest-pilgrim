package probe;
import android.app.Activity; import android.net.Uri; import android.os.Bundle; import android.database.Cursor; import android.util.Log;
import java.io.InputStream; import java.util.zip.*;
/** Test-only: receives a shared zip, reads it through the granted URI, logs name/size/CRC/entries. */
public class Recv extends Activity {
  @Override protected void onCreate(Bundle b) { super.onCreate(b);
    try { Uri u = getIntent().getParcelableExtra("android.intent.extra.STREAM"); String name = "?"; long size = -1;
      try (Cursor c = getContentResolver().query(u, null, null, null, null)) { if (c != null && c.moveToFirst()) { name = c.getString(c.getColumnIndex("_display_name")); size = c.getLong(c.getColumnIndex("_size")); } }
      StringBuilder ents = new StringBuilder(); long n = 0;
      try (InputStream in = getContentResolver().openInputStream(u); ZipInputStream z = new ZipInputStream(in)) {
        ZipEntry e; byte[] buf = new byte[8192]; while ((e = z.getNextEntry()) != null) { int k; while ((k = z.read(buf)) > 0) n += k; ents.append(e.getName()).append(' '); } }
      Log.i("SHAREPROBE", "OK uri=" + u + " name=" + name + " size=" + size + " entries=" + ents + "bytes=" + n);
    } catch (Exception e) { Log.i("SHAREPROBE", "FAIL " + e); }
    finish(); }
}
