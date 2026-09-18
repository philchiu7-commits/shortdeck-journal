/* pinyin.js — toneless hanzi→pinyin lookup so romanized typing ("wang", "ping
   ping", "wls") finds Chinese-named opponents. Not exhaustive: covers the
   characters in the current roster plus common surnames / given-name chars.
   Add entries freely — an unknown char just contributes nothing to the match. */
const HANZI_PINYIN = {
  // — roster characters —
  "在":"zai","維":"wei","维":"wei","王":"wang","老":"lao","師":"shi","师":"shi",
  "方":"fang","納":"na","纳":"na","蘭":"lan","兰":"lan","祥":"xiang","馬":"ma","马":"ma",
  "秦":"qin","龍":"long","龙":"long","小":"xiao","爺":"ye","爷":"ye","郭":"guo",
  "金":"jin","科":"ke","哥":"ge","雞":"ji","鸡":"ji","一":"yi","夫":"fu","斌":"bin",
  // — common surnames (trad + simp) —
  "李":"li","張":"zhang","张":"zhang","劉":"liu","刘":"liu","陳":"chen","陈":"chen",
  "楊":"yang","杨":"yang","黃":"huang","黄":"huang","趙":"zhao","赵":"zhao","吳":"wu","吴":"wu",
  "周":"zhou","徐":"xu","孫":"sun","孙":"sun","朱":"zhu","胡":"hu","何":"he","高":"gao",
  "林":"lin","羅":"luo","罗":"luo","鄭":"zheng","郑":"zheng","梁":"liang","謝":"xie","谢":"xie",
  "宋":"song","唐":"tang","許":"xu","韓":"han","韩":"han","馮":"feng","冯":"feng","鄧":"deng","邓":"deng",
  "曹":"cao","彭":"peng","曾":"zeng","肖":"xiao","蕭":"xiao","萧":"xiao","田":"tian","董":"dong",
  "潘":"pan","袁":"yuan","蔡":"cai","蔣":"jiang","蒋":"jiang","余":"yu","于":"yu","杜":"du",
  "葉":"ye","叶":"ye","程":"cheng","蘇":"su","苏":"su","魏":"wei","呂":"lyu","吕":"lyu",
  "丁":"ding","任":"ren","盧":"lu","卢":"lu","沈":"shen","姚":"yao","傅":"fu","鐘":"zhong","钟":"zhong",
  "姜":"jiang","崔":"cui","譚":"tan","谭":"tan","廖":"liao","范":"fan","汪":"wang","陸":"lu","陆":"lu",
  "石":"shi","戴":"dai","賈":"jia","贾":"jia","韋":"wei","韦":"wei","夏":"xia","邱":"qiu","侯":"hou",
  "鄒":"zou","邹":"zou","熊":"xiong","孟":"meng","白":"bai","江":"jiang","閻":"yan","阎":"yan",
  "薛":"xue","尹":"yin","段":"duan","雷":"lei","黎":"li","史":"shi","賀":"he","贺":"he","陶":"tao",
  "顧":"gu","顾":"gu","毛":"mao","郝":"hao","龔":"gong","龚":"gong","邵":"shao","萬":"wan","万":"wan",
  "錢":"qian","钱":"qian","嚴":"yan","严":"yan","覃":"qin","武":"wu","戚":"qi","莫":"mo","孔":"kong",
  "向":"xiang","湯":"tang","汤":"tang","常":"chang","溫":"wen","温":"wen","康":"kang","施":"shi",
  "文":"wen","牛":"niu","樊":"fan","葛":"ge","邢":"xing","洪":"hong","詹":"zhan","申":"shen",
  "關":"guan","关":"guan","阮":"ruan","席":"xi",
  // — common given-name characters —
  "明":"ming","華":"hua","华":"hua","建":"jian","國":"guo","国":"guo","平":"ping","強":"qiang","强":"qiang",
  "軍":"jun","军":"jun","偉":"wei","伟":"wei","峰":"feng","磊":"lei","濤":"tao","涛":"tao","勇":"yong",
  "杰":"jie","傑":"jie","波":"bo","輝":"hui","辉":"hui","剛":"gang","刚":"gang","飛":"fei","飞":"fei",
  "鵬":"peng","鹏":"peng","超":"chao","陽":"yang","阳":"yang","光":"guang","天":"tian","志":"zhi",
  "宇":"yu","浩":"hao","亮":"liang","俊":"jun","鑫":"xin","虎":"hu","豪":"hao","帥":"shuai","帅":"shuai",
  "旺":"wang","財":"cai","财":"cai","富":"fu","貴":"gui","贵":"gui","生":"sheng","發":"fa","发":"fa",
  "福":"fu","壽":"shou","寿":"shou","喜":"xi","樂":"le","乐":"le","順":"shun","顺":"shun",
};

/* Return { full, initials } toneless pinyin for a string. Non-Han chars are
   kept as-is (lowercased) in `full`; Han chars contribute their initial. */
function toPinyin(str) {
  let full = "", initials = "";
  for (const ch of String(str || "")) {
    const py = HANZI_PINYIN[ch];
    if (py) { full += py; initials += py[0]; }
    else if (/[a-z0-9]/i.test(ch)) { full += ch.toLowerCase(); initials += ch.toLowerCase(); }
  }
  return { full, initials };
}
