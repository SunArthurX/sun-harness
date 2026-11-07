from models import Line

def order_total(lines: list[Line]) -> float:
    return round(sum(l.unit_price * l.qty for l in lines), 2)
