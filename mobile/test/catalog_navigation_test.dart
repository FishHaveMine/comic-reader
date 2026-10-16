import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/models/catalog_navigation.dart';

void main() {
  test('返回首页保留分类及筛选参数', () {
    final url = Uri.parse(catalogHomeUrl);
    expect(url.origin + url.path, 'https://www.baozimh.com/classify');
    expect(url.queryParameters, {
      'type': 'all',
      'region': 'all',
      'state': 'all',
      'filter': '*',
    });
  });
  test('选章转换与桌面端一致，详情和分类页面不直接当作章节', () {
    expect(
      chapterFromCatalog(
        'https://www.baozimh.com/user/page_direct?comic_id=wuliandianfeng-pikapi_lav8od&section_slot=0&chapter_slot=0',
      ),
      'https://www.twmanga.com/comic/chapter/wuliandianfeng-pikapi_lav8od/0_0.html',
    );
    expect(
      chapterFromCatalog(
        'https://www.twmanga.com/comic/chapter/demo/0_6.html#top',
      ),
      'https://www.twmanga.com/comic/chapter/demo/0_6.html',
    );
    expect(isCatalogUrl('https://cn.bzmgcn.com/classify'), true);
    expect(chapterFromCatalog(catalogHomeUrl), isNull);
    expect(chapterFromCatalog('https://www.baozimh.com/comic/demo'), isNull);
  });
  test('拒绝外站伪装、无效参数与非网络协议', () {
    expect(isCatalogUrl('https://baozimh.com.evil.com/comic/demo'), false);
    expect(chapterFromCatalog('javascript:alert(1)'), isNull);
    expect(
      chapterFromCatalog(
        'https://www.baozimh.com/user/page_direct?comic_id=../bad&section_slot=0&chapter_slot=1',
      ),
      isNull,
    );
    expect(
      chapterFromCatalog(
        'https://www.baozimh.com/user/page_direct?comic_id=demo&chapter_slot=1',
      ),
      isNull,
    );
  });
}
