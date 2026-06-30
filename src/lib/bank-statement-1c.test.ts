import { describe, expect, it } from "vitest";
import { is1CStatement, parse1CStatement } from "./bank-statement-1c";

const SAMPLE = `1CClientBankExchange
ВерсияФормата=1.03
Кодировка=Windows
Отправитель=Банк
ДатаСоздания=29.06.2026
СекцияРасчСчет
ДатаНачала=01.06.2026
ДатаКонца=29.06.2026
РасчСчет=40802810320000529160
БИК=044525104
НачальныйОстаток=100000.00
КонечныйОстаток=145500.50
КонецРасчСчет
СекцияДокумент=Платежное поручение
Номер=101
Дата=15.06.2026
Сумма=60000.00
ПлательщикСчет=40702810000000001111
Плательщик=ООО Покупатель
ПлательщикИНН=7700000001
ПолучательСчет=40802810320000529160
Получатель=ИП Наш
ПолучательИНН=7800000002
НазначениеПлатежа=Оплата за столы по счёту 5
КонецДокумента
СекцияДокумент=Платежное поручение
Номер=102
Дата=20.06.2026
Сумма=14499.50
ПлательщикСчет=40802810320000529160
Плательщик=ИП Наш
ПлательщикИНН=7800000002
ПолучательСчет=40702810000000002222
Получатель=ООО Поставщик Рейки
ПолучательИНН=7700000003
НазначениеПлатежа=Закупка пиломатериала
КонецДокумента
КонецФайла`;

describe("parse1CStatement", () => {
  it("распознаёт формат", () => {
    expect(is1CStatement(SAMPLE)).toBe(true);
    expect(is1CStatement("просто текст")).toBe(false);
  });

  it("парсит реквизиты счёта и остатки", () => {
    const st = parse1CStatement(SAMPLE);
    expect(st.accountNumber).toBe("40802810320000529160");
    expect(st.bik).toBe("044525104");
    expect(st.dateStart).toBe("2026-06-01");
    expect(st.dateEnd).toBe("2026-06-29");
    expect(st.openingBalance).toBe(100000);
    expect(st.closingBalance).toBe(145500.5);
  });

  it("парсит две операции с реквизитами сторон", () => {
    const st = parse1CStatement(SAMPLE);
    expect(st.documents).toHaveLength(2);

    const [income, expense] = st.documents;
    expect(income.docNumber).toBe("101");
    expect(income.date).toBe("2026-06-15");
    expect(income.amount).toBe(60000);
    expect(income.payerName).toBe("ООО Покупатель");
    expect(income.payeeAccount).toBe("40802810320000529160");
    expect(income.purpose).toContain("столы");

    expect(expense.amount).toBe(14499.5);
    expect(expense.payerAccount).toBe("40802810320000529160");
    expect(expense.payeeName).toBe("ООО Поставщик Рейки");
    expect(expense.payeeInn).toBe("7700000003");
  });

  it("выписка без операций — пустой список, остатки заданы", () => {
    const empty = `1CClientBankExchange
ВерсияФормата=1.03
СекцияРасчСчет
РасчСчет=40802810320000529160
НачальныйОстаток=5000.00
КонечныйОстаток=5000.00
КонецРасчСчет
КонецФайла`;
    const st = parse1CStatement(empty);
    expect(st.documents).toHaveLength(0);
    expect(st.closingBalance).toBe(5000);
  });
});
